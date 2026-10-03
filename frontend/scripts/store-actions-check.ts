import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { useRecipeStore } from '../src/stores/recipeStore'
import { useRunStore } from '../src/stores/runStore'
import { useDeveloperStore } from '../src/stores/developerStore'
import { db } from '../src/utils/db'
import { publishRecipeDraft } from '../src/utils/recipeVersioning'
import { strict as assert } from 'node:assert'

let passed = 0
function check(name: string, cond: boolean) {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 直接用模块单例（首次打开会灌入 v3 种子：含草稿、进行中、等待已确认/未确认罐次）
async function testStoreActions() {
  console.log('场景 6：页面动作（Pinia store）端到端')
  setActivePinia(createPinia())
  const recipeStore = useRecipeStore()
  const runStore = useRunStore()
  const developerStore = useDeveloperStore()
  await Promise.all([recipeStore.load(), runStore.load(), developerStore.load()])

  check('种子库有 7 个已发布逻辑配方', recipeStore.currentRecipes.length === 7)
  check('种子库有 1 条待发布草稿（配方 7）', recipeStore.draftRecipes.length === 1)
  check('进行中 1 罐、等待 2 罐、完成 7 罐',
    runStore.inProgressRuns.length === 1 && runStore.waitingRuns.length === 2 && runStore.completedRuns.length === 7)
  check('待确认计数为 1', runStore.unconfirmedCount === 1)

  // 未确认不能开冲
  const unconfirmed = runStore.waitingRuns.find((run) => !run.confirmed)!
  let blocked: unknown = null
  try {
    await runStore.startRun(unconfirmed.id!)
  } catch (error) {
    blocked = error
  }
  check('未确认罐次开冲被拒绝', blocked instanceof Error)

  // 已确认的等待罐次先改胶片批次 → 确认作废
  const confirmedWaiting = runStore.waitingRuns.find((run) => run.confirmed)!
  const oldFilm = confirmedWaiting.filmId
  const otherFilm = (await db.films.toArray()).find((film) => film.id !== oldFilm)!.id!
  await runStore.changeWaitingMaterial(confirmedWaiting.id!, { filmId: otherFilm })
  let reloaded = runStore.runs.find((run) => run.id === confirmedWaiting.id)!
  check('换胶片批次后确认被清除', reloaded.confirmed === false && reloaded.confirmedAt === undefined)
  let blocked2: unknown = null
  try {
    await runStore.startRun(reloaded.id!)
  } catch (error) {
    blocked2 = error
  }
  check('换料后未重新确认仍不能开冲', blocked2 instanceof Error)

  // 重新确认 → 开冲成功，版本固定且显影液占用一卷
  await runStore.confirmRun(reloaded.id!)
  const devBefore = developerStore.developers.find((d) => d.id === reloaded.developerId)!
  const pinnedVersion = reloaded.recipeVersion
  await runStore.startRun(reloaded.id!)
  await developerStore.load()
  reloaded = runStore.runs.find((run) => run.id === reloaded.id)!
  check('确认后可开冲，状态变进行中', reloaded.status === 'in_progress')
  check('开冲后绑定版本固定', reloaded.recipeVersion === pinnedVersion)
  const devAfter = developerStore.developers.find((d) => d.id === devBefore.id)!
  check('开冲占用一卷显影液', devAfter.usedRolls === devBefore.usedRolls + 1)

  // 原本就进行中的罐次（recipeId 2 v1）：即使给配方 2 发布新版，也继续读旧版
  const progressRun = runStore.inProgressRuns.find((run) => run.recipeId === 2 && run.id !== reloaded.id)
  if (progressRun) {
    const v1 = recipeStore.getVersion(2, 1)!
    const draftId = await recipeStore.saveDraft(2, {
      filmId: v1.filmId, developerId: v1.developerId, dilution: v1.dilution, tempC: v1.tempC,
      devMinutes: v1.devMinutes + 2, agitation: v1.agitation, stopBath: v1.stopBath,
      fixer: v1.fixer, washMinutes: v1.washMinutes, pushPull: v1.pushPull, note: 'store 测试新版'
    })
    const pub = await recipeStore.publishDraft(draftId)
    check('配方 2 发布 v2（仅参数变化）', pub.version === 2)
    const progressAfter = runStore.runs.find((run) => run.id === progressRun.id)!
    check('进行中罐次仍读 v1', progressAfter.recipeVersion === 1)
  }

  // 全新配方：草稿态不能排期，发布后才能排入等待且初始未确认
  const created = await recipeStore.createDraft({
    filmId: 1, developerId: 1, dilution: '1:1', tempC: 20, devMinutes: 8,
    agitation: 'a', stopBath: 's', fixer: 'f', washMinutes: 10, pushPull: 'N', note: '新配方'
  })
  let scheduleBlocked: unknown = null
  try {
    await runStore.scheduleRun({ batchNo: 'W-NEW', recipeId: created.recipeId, tankType: '双联罐', runDate: '2026-10-10' })
  } catch (error) {
    scheduleBlocked = error
  }
  check('草稿配方不能排入等待', scheduleBlocked instanceof Error)
  const newPub = await recipeStore.publishDraft(created.id)
  check('新配方首次发布为 v1', newPub.version === 1)
  const newRunId = await runStore.scheduleRun({ batchNo: 'W-NEW', recipeId: created.recipeId, tankType: '双联罐', runDate: '2026-10-10' })
  const newRun = runStore.runs.find((run) => run.id === newRunId)!
  check('发布后排入等待，绑定 v1 且初始未确认', newRun.recipeVersion === 1 && newRun.confirmed === false && newRun.status === 'waiting')

  // 令牌持久化与崩溃重试：发布事务在提交前失败 → 令牌留在草稿上 → 再发布复用令牌
  const retryCreated = await recipeStore.createDraft({
    filmId: 1, developerId: 1, dilution: '1:1', tempC: 20, devMinutes: 9,
    agitation: 'a', stopBath: 's', fixer: 'f', washMinutes: 10, pushPull: 'N', note: '重试场景'
  })
  // 模拟首次发起：令牌已落草稿（store 在事务外先持久化），随后发布事务被强制中止
  const pendingToken = `pub-manual-${Date.now()}`
  await db.recipes.update(retryCreated.id, { pendingPublishToken: pendingToken })
  let firstFailure: unknown = null
  try {
    await db.transaction('rw', db.recipes, db.runs, async (tx) => {
      await publishRecipeDraft(retryCreated.id, pendingToken)
      tx.abort(new Error('提交前崩溃'))
    })
  } catch (error) {
    firstFailure = error
  }
  check('首次发布事务失败', firstFailure instanceof Error)
  const draftAfterFailure = await db.recipes.get(retryCreated.id)!
  check('失败后草稿保留且挂有待用令牌', draftAfterFailure.status === 'draft' && Boolean(draftAfterFailure.pendingPublishToken))
  const persistedToken = draftAfterFailure.pendingPublishToken

  // store 层再发布应复用同一令牌（此处直接走 publishDraft：草稿已有 pendingPublishToken）
  const retryPub = await recipeStore.publishDraft(retryCreated.id)
  check('重试发布成功', retryPub.version === 1)
  const sameTokenRows = await db.recipes.where('publishToken').equals(persistedToken!).toArray()
  check('复用的是失败前挂在草稿上的同一令牌', sameTokenRows.length === 1 && sameTokenRows[0].version === 1)
  check('重试后没有重复版本',
    (await db.recipes.where('recipeId').equals(retryCreated.recipeId).and((r) => r.status === 'published').count()) === 1)
}

async function main() {
  await testStoreActions()
  console.log(`\nStore 场景通过：${passed} 项断言`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
