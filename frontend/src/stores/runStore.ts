import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun, RunStatus, TankType } from '../types/dev-run'

export interface NewRunInput {
  batchNo: string
  recipeId: number
  tankType: TankType
  runDate: string
}

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    waitingRuns: (state) => state.runs
      .filter((run) => run.status === 'waiting')
      .sort((a, b) => a.runDate.localeCompare(b.runDate)),
    inProgressRuns: (state) => state.runs
      .filter((run) => run.status === 'in_progress')
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')),
    completedRuns: (state) => state.runs
      .filter((run) => run.status === 'completed')
      .sort((a, b) => b.runDate.localeCompare(a.runDate)),
    recentRuns(): DevRun[] {
      return this.completedRuns.slice(0, 6)
    },
    unconfirmedCount(): number {
      return this.waitingRuns.filter((run) => !run.confirmed).length
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').toArray()
      } finally {
        this.loading = false
      }
    },
    /** 排入等待：按配方最新发布版本排期，初始一律未确认，确认后才能开冲 */
    async scheduleRun(payload: NewRunInput): Promise<number> {
      const published = await db.recipes
        .where('recipeId').equals(payload.recipeId)
        .and((item) => item.status === 'published')
        .toArray()
      const current = published.reduce<typeof published[number] | undefined>(
        (max, item) => (!max || (item.version ?? 0) > (max.version ?? 0) ? item : max),
        undefined
      )
      if (!current || current.version === undefined) {
        throw new Error('该配方还没有已发布版本，不能排期')
      }
      const next: DevRun = {
        batchNo: payload.batchNo,
        recipeId: payload.recipeId,
        recipeVersion: current.version,
        filmId: current.filmId,
        developerId: current.developerId,
        status: 'waiting',
        confirmed: false,
        actualTempC: current.tempC,
        actualMinutes: current.devMinutes,
        tankType: payload.tankType,
        runDate: payload.runDate,
        result: '',
        schemaRev: 3
      }
      const id = await db.runs.add(plain(next))
      await this.load()
      return id
    },
    /** 等待中调整胶片批次或显影液：物料变化，必须重新确认 */
    async changeWaitingMaterial(
      runId: number,
      patch: { filmId?: number; developerId?: number; actualTempC?: number; actualMinutes?: number }
    ): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run || run.status !== 'waiting') return
      const materialChanged = (patch.filmId !== undefined && patch.filmId !== run.filmId)
        || (patch.developerId !== undefined && patch.developerId !== run.developerId)
      // 换胶片批次或显影液后作废原确认；整对象 put 以确保确认时间戳被删除
      const updated: DevRun = {
        ...run,
        ...patch,
        confirmed: materialChanged ? false : run.confirmed
      }
      if (materialChanged) {
        updated.confirmedAt = undefined
        updated.confirmedNote = undefined
      }
      await db.runs.put(plain(updated))
      await this.load()
    },
    /** 确认等待中的实冲；只能针对当前绑定版本与物料确认 */
    async confirmRun(runId: number, note?: string): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run || run.status !== 'waiting') return
      await db.runs.update(runId, plain({
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        confirmedNote: note?.trim() || (run.confirmedNote ?? '已按当前配方版本与物料核对')
      }))
      await this.load()
    },
    /** 开冲：未确认一律拒绝；绑定的配方版本此后固定，并占用一卷显影液 */
    async startRun(runId: number, startedAt = new Date().toISOString()): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run || run.status !== 'waiting') return
      if (!run.confirmed) {
        throw new Error('等待中的实冲尚未确认，不能开冲')
      }
      await db.transaction('rw', db.runs, db.developers, async () => {
        await db.runs.update(runId, plain({
          status: 'in_progress',
          startedAt,
          runDate: startedAt.slice(0, 10)
        }))
        const developer = await db.developers.get(run.developerId)
        if (developer && developer.id !== undefined && developer.state !== '报废') {
          await db.developers.update(developer.id, plain({ usedRolls: developer.usedRolls + 1 }))
        }
      })
      await this.load()
    },
    /** 完成罐次：固化结果，此后只读绑定版本 */
    async completeRun(
      runId: number,
      payload: { actualTempC: number; actualMinutes: number; result: string; runDate?: string }
    ): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run || run.status !== 'in_progress') return
      await db.runs.update(runId, plain({
        actualTempC: payload.actualTempC,
        actualMinutes: payload.actualMinutes,
        result: payload.result.trim(),
        runDate: payload.runDate ?? run.runDate,
        status: 'completed' satisfies RunStatus
      }))
      await this.load()
    }
  }
})
