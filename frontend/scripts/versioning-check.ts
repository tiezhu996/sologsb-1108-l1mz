import 'fake-indexeddb/auto'
import Dexie, { type Table } from 'dexie'
import { strict as assert } from 'node:assert'
import { FilmDevDatabase } from '../src/utils/db'
import { publishRecipeDraft, newPublishToken } from '../src/utils/recipeVersioning'
import type { DevRecipe } from '../src/types/dev-recipe'
import type { DevRun } from '../src/types/dev-run'

let activeDb: FilmDevDatabase | null = null
const publishTx = (draftId: number, token: string) => {
  if (!activeDb) throw new Error('测试数据库未初始化')
  return publishRecipeDraft(draftId, token, activeDb)
}

let passed = 0
function check(name: string, cond: boolean) {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

// ---------- 场景 1：v2 旧库迁移（已有数据按初版迁移） ----------
async function testMigration() {
  console.log('场景 1：v2 → v3 迁移')
  const dbName = 'gbfilmdev-test-migration'

  // 用只到 v2 的结构写入旧数据
  interface LegacyRecipe { id?: number; filmId: number; developerId: number; tempC: number; devMinutes: number; schemaRev?: number }
  interface LegacyRun { id?: number; batchNo: string; recipeId: number; actualTempC: number; actualMinutes: number; tankType: '双联罐' | '深罐'; runDate: string; result: string; schemaRev?: number }
  const legacy = new Dexie(dbName) as Dexie & {
    recipes: Table<LegacyRecipe, number>
    runs: Table<LegacyRun, number>
  }
  legacy.version(1).stores({
    films: '++id', developers: '++id',
    recipes: '++id, filmId, developerId',
    runs: '++id, recipeId, runDate, tankType'
  })
  legacy.version(2).stores({
    films: '++id', developers: '++id',
    recipes: '++id, filmId, developerId',
    runs: '++id, recipeId, runDate, tankType'
  })
  await legacy.recipes.bulkAdd([
    { id: 1, filmId: 1, developerId: 1, tempC: 20, devMinutes: 9, schemaRev: 2 },
    { id: 2, filmId: 2, developerId: 2, tempC: 20, devMinutes: 7, schemaRev: 2 }
  ])
  await legacy.runs.bulkAdd([
    { id: 1, batchNo: 'OLD-1', recipeId: 1, actualTempC: 20, actualMinutes: 9, tankType: '双联罐', runDate: '2026-09-01', result: 'ok', schemaRev: 2 },
    { id: 2, batchNo: 'OLD-2', recipeId: 2, actualTempC: 20, actualMinutes: 7, tankType: '深罐', runDate: '2026-09-02', result: 'ok', schemaRev: 2 }
  ])
  await legacy.close()

  const db = new FilmDevDatabase(dbName, { seed: false })
  activeDb = db
  const recipes = await db.recipes.toArray()
  const runs = await db.runs.toArray()

  check('旧配方成为各自逻辑配方的初版 v1', recipes.every((r) => r.status === 'published' && r.version === 1))
  check('recipeId 按原行 id 迁移', recipes.every((r) => r.recipeId === r.id))
  check('历史实冲为已完成并绑定 v1', runs.every((r) => r.status === 'completed' && r.recipeVersion === 1 && r.confirmed === true))
  check('历史实冲回填了胶片/显影物料快照', runs.every((r) => r.filmId !== 0 && r.developerId !== 0))
  check('旧配方参数值保留', recipes.find((r) => r.id === 1)?.devMinutes === 9)
  db.close()
}

// ---------- 场景 2-5：全新库下的发布/确认/幂等/失败语义 ----------
async function testPublishingLifecycle() {
  console.log('场景 2：草稿发布后等待中实冲换版、在冲与完成不动')
  const dbName = 'gbfilmdev-test-flow'
  const db = new FilmDevDatabase(dbName, { seed: false })
  activeDb = db

  // 物料
  await db.table('films').bulkAdd([
    { id: 1, model: 'GP3', format: '135', emulsionNo: 'EMU-A', rollsLeft: 5, schemaRev: 3 },
    { id: 2, model: 'GP3', format: '120', emulsionNo: 'EMU-B', rollsLeft: 3, schemaRev: 3 }
  ] as never[])
  await db.table('developers').bulkAdd([
    { id: 1, name: 'D76', category: 'D-76', dilution: '1:1', state: '在用', usedRolls: 0, maxRolls: 10, schemaRev: 3 },
    { id: 2, name: 'HC110', category: 'HC-110', dilution: '1:3', state: '在用', usedRolls: 0, maxRolls: 10, schemaRev: 3 }
  ] as never[])

  const base = {
    dilution: '1:1' as const, tempC: 20, devMinutes: 10,
    agitation: 'a', stopBath: 's', fixer: 'f', washMinutes: 10, pushPull: 'N' as const, note: ''
  }
  const v1Id = await db.recipes.add({ recipeId: 1, version: 1, status: 'published', filmId: 1, developerId: 1, ...base, schemaRev: 3 })
  void v1Id

  // 三类罐次
  const waitingId = await db.runs.add({
    batchNo: 'W1', recipeId: 1, recipeVersion: 1, filmId: 1, developerId: 1,
    status: 'waiting', confirmed: true, confirmedAt: '2026-10-01T00:00:00Z',
    actualTempC: 20, actualMinutes: 10, tankType: '双联罐', runDate: '2026-10-05', result: '', schemaRev: 3
  })
  const progressId = await db.runs.add({
    batchNo: 'P1', recipeId: 1, recipeVersion: 1, filmId: 1, developerId: 1,
    status: 'in_progress', confirmed: true,
    actualTempC: 20, actualMinutes: 10, tankType: '双联罐', runDate: '2026-10-03', startedAt: '2026-10-03T08:00:00Z', result: '', schemaRev: 3
  })
  const doneId = await db.runs.add({
    batchNo: 'D1', recipeId: 1, recipeVersion: 1, filmId: 1, developerId: 1,
    status: 'completed', confirmed: true,
    actualTempC: 20, actualMinutes: 10, tankType: '双联罐', runDate: '2026-09-30', result: 'good', schemaRev: 3
  })

  // 草稿：只改时间（参数变化，不动物料）
  const draftId = await db.recipes.add({
    recipeId: 1, status: 'draft', filmId: 1, developerId: 1,
    ...base, devMinutes: 11, note: '延长 1 分钟', schemaRev: 3
  })

  const token = newPublishToken()
  const result = await publishTx(draftId, token)
  check('发布生成 v2', result.version === 2 && !result.retried)
  check('草稿发布后删除', (await db.recipes.get(draftId)) === undefined)
  const waiting = await db.runs.get(waitingId) as DevRun
  check('等待中实冲改用新版本 v2', waiting.recipeVersion === 2)
  check('等待中实冲采用新参数（11 分钟）', waiting.actualMinutes === 11)
  check('仅参数变化时确认结果保留', waiting.confirmed === true && waiting.confirmedAt !== undefined)
  const progress = await db.runs.get(progressId) as DevRun
  check('进行中继续读旧版 v1', progress.recipeVersion === 1 && progress.actualMinutes === 10)
  const done = await db.runs.get(doneId) as DevRun
  check('已完成罐次不动', done.recipeVersion === 1 && done.result === 'good')

  console.log('场景 3：同令牌重试不重复生成版本')
  const retry = await publishTx(0, token) // draftId 已删除 → 但 v2 已带 token
  check('重试返回已发布版本且标记 retried', retry.version === 2 && retry.retried === true)
  const publishedCount = await db.recipes.where('recipeId').equals(1).and((r) => r.status === 'published').count()
  check('版本总数仍为 2', publishedCount === 2)

  console.log('场景 4：胶片/显影液变化时等待中实冲必须重新确认')
  const draft2 = await db.recipes.add({
    recipeId: 1, status: 'draft', filmId: 2, developerId: 1,
    ...base, devMinutes: 11, schemaRev: 3
  })
  const token2 = newPublishToken()
  const result4 = await publishTx(draft2, token2)
  check('发布生成 v3', result4.version === 3)
  check('返回需要重新确认的等待罐次', result4.reconfirmedRunIds.includes(waitingId as number))
  const waiting3 = await db.runs.get(waitingId) as DevRun
  check('等待中实冲换版且确认被清除', waiting3.recipeVersion === 3 && waiting3.confirmed === false && waiting3.confirmedAt === undefined)
  check('等待中实冲物料跟随新版胶片', waiting3.filmId === 2)
  const progressStillV1 = await db.runs.get(progressId) as DevRun
  check('进行中仍读 v1 不受影响', progressStillV1.recipeVersion === 1)

  console.log('场景 5：发布失败保留草稿与确认结果，可重试成功')
  const draft4 = await db.recipes.add({
    recipeId: 1, status: 'draft', filmId: 2, developerId: 2,
    ...base, devMinutes: 13, schemaRev: 3
  })
  const token4 = newPublishToken()
  let aborted: unknown = null
  try {
    // 发布事务嵌套进外层事务，外层强制中止时发布动作应整体回滚
    await db.transaction('rw', db.recipes, db.runs, async (tx) => {
      await publishTx(draft4, token4)
      tx.abort(new Error('强制回滚'))
    })
  } catch (error) {
    aborted = error
  }
  check('事务被强制中止', aborted instanceof Error)
  // publishRecipeDraft 用的是它自己的事务（嵌套事务在 Dexie 中加入外层事务，会随外层一起回滚）
  const draft4Still = await db.recipes.get(draft4)
  const publishedAfterAbort = await db.recipes.where('recipeId').equals(1).and((r) => r.status === 'published').count()
  check('失败后草稿保留', draft4Still !== undefined && draft4Still.status === 'draft')
  check('失败后没有生成新版本（仍为 3 个发布版）', publishedAfterAbort === 3)
  const waitingAfterAbort = await db.runs.get(waitingId) as DevRun
  check('失败后确认结果未被改写（仍待确认，版本 v3）', waitingAfterAbort.recipeVersion === 3 && waitingAfterAbort.confirmed === false)

  // 同 token 重试 → 成功且只产生一个版本
  const retry4 = await publishTx(draft4, token4)
  check('重试成功发布 v4', retry4.version === 4)
  const publishedAfterRetry = await db.recipes.where('recipeId').equals(1).and((r) => r.status === 'published').count()
  check('重试后版本数为 4，无重复', publishedAfterRetry === 4)
  check('重试后草稿已删除', (await db.recipes.get(draft4)) === undefined)
  const waitingFinal = await db.runs.get(waitingId) as DevRun
  check('重试发布后等待罐次换版且再次要求确认', waitingFinal.recipeVersion === 4 && waitingFinal.confirmed === false)
  const secondRetry = await publishTx(0, token4)
  check('再次重试幂等返回 v4', secondRetry.version === 4 && secondRetry.retried)

  db.close()
}

async function main() {
  await testMigration()
  await testPublishingLifecycle()
  console.log(`\n全部通过：${passed} 项断言`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
