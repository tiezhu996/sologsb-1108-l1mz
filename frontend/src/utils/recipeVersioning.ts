import { db as defaultDb, plain } from './db'
import type { FilmDevDatabase } from './db'
import type { DevRecipe, MaterialChange } from '../types/dev-recipe'
import type { DevRun } from '../types/dev-run'

export function newPublishToken(): string {
  return `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 相对当前已发布版本，草稿在物料层面的变化（只关心胶片批次与显影液工作液） */
export function diffMaterial(
  draft: DevRecipe,
  current: DevRecipe | undefined
): MaterialChange {
  return {
    filmChanged: current !== undefined && draft.filmId !== current.filmId,
    developerChanged: current !== undefined && draft.developerId !== current.developerId
  }
}

/** 等待中的实冲在配方物料变化后是否需要重新确认 */
export function needsReconfirm(
  run: Pick<DevRun, 'status'>,
  change: MaterialChange
): boolean {
  if (run.status !== 'waiting') return false
  // 配方换了胶片批次或显影液工作液，该配方下所有等待中的实冲都要重新核对
  return change.filmChanged || change.developerChanged
}

export interface PublishResult {
  version: number
  recipeRowId: number
  reconfirmedRunIds: number[]
  /** 重试同一 publishToken 且版本已生成时为 true，表示没有重复产生新版本 */
  retried: boolean
}

/**
 * 发布配方草稿：
 * - 编辑只产生草稿，调用本方法才生成新版本；
 * - 发布后等待中的实冲改用新版本（进行中/已完成不动，继续读旧版）；
 * - 胶片批次或显影液变化时，等待中的实冲取消确认，未确认不能开冲；
 * - 通过 publishToken 保证幂等：发布失败后用同一令牌重试不会重复生成版本。
 * 整个过程在单个 Dexie 事务内完成，失败时草稿与已有确认结果原样保留。
 */
export async function publishRecipeDraft(
  draftId: number,
  publishToken: string,
  database: FilmDevDatabase = defaultDb
): Promise<PublishResult> {
  return database.transaction('rw', database.recipes, database.runs, async () => {
    // 幂等：同一发起令牌已成功发布过，直接返回已有版本，不再新增。
    // 放在草稿校验之前，这样发布成功后用同一令牌重试（草稿已删除）也能命中。
    const existing = await database.recipes
      .where('publishToken').equals(publishToken)
      .and((item) => item.status === 'published')
      .first()
    if (existing && existing.id !== undefined && existing.version !== undefined) {
      return {
        version: existing.version,
        recipeRowId: existing.id,
        reconfirmedRunIds: [],
        retried: true
      }
    }

    const draft = await database.recipes.get(draftId)
    if (!draft || draft.status !== 'draft' || draft.id === undefined) {
      throw new Error('待发布的配方草稿不存在')
    }
    const logicalId = draft.recipeId

    const publishedRows = await database.recipes
      .where('recipeId').equals(logicalId)
      .and((item) => item.status === 'published')
      .toArray()
    const latestVersion = publishedRows.reduce(
      (max, item) => Math.max(max, item.version ?? 0),
      0
    )
    const previous = publishedRows
      .filter((item) => item.version === latestVersion)[0]
    const nextVersion = latestVersion + 1
    const materialChange = diffMaterial(draft, previous)

    // 先占位再回填，确保 publishToken 唯一索引从事务开始就生效
    const rowId = await database.recipes.add(plain({
      recipeId: logicalId,
      version: nextVersion,
      status: 'published',
      filmId: draft.filmId,
      developerId: draft.developerId,
      dilution: draft.dilution,
      tempC: draft.tempC,
      devMinutes: draft.devMinutes,
      agitation: draft.agitation,
      stopBath: draft.stopBath,
      fixer: draft.fixer,
      washMinutes: draft.washMinutes,
      pushPull: draft.pushPull,
      note: draft.note ?? '',
      publishToken,
      publishedAt: new Date().toISOString(),
      schemaRev: 3
    } satisfies DevRecipe))

    // 等待中的实冲改用新版本；进行中与已完成继续读旧版
    const waitingRuns = await database.runs
      .where('recipeId').equals(logicalId)
      .and((run) => run.status === 'waiting')
      .toArray()
    const reconfirmedRunIds: number[] = []
    await Promise.all(waitingRuns.map(async (run) => {
      if (run.id === undefined) return
      const updated: DevRun = {
        ...run,
        recipeVersion: nextVersion,
        filmId: draft.filmId,
        developerId: draft.developerId,
        actualTempC: draft.tempC,
        actualMinutes: draft.devMinutes
      }
      // 胶片批次或显影液变化 → 重新确认；仅参数变化则保留既有确认。
      // 整对象 put 覆盖，确保 confirmedAt/confirmedNote 被真正删除
      // （JSON 序列化会移除 undefined 键，Table.update 对 undefined 键不会删列）。
      if (needsReconfirm(run, materialChange)) {
        updated.confirmed = false
        updated.confirmedAt = undefined
        updated.confirmedNote = undefined
        reconfirmedRunIds.push(run.id)
      }
      await database.runs.put(plain(updated))
    }))

    await database.recipes.delete(draftId)

    return {
      version: nextVersion,
      recipeRowId: rowId,
      reconfirmedRunIds,
      retried: false
    }
  })
}
