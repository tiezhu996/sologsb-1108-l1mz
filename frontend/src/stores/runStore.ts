import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun, RunCompletion, RunStatus } from '../types/dev-run'

type ScheduleRun = Pick<DevRun, 'batchNo' | 'recipeId' | 'runDate'>

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    completedRuns: (state) => state.runs.filter((run) => run.status === 'completed'),
    recentRuns(): DevRun[] {
      return this.completedRuns
        .sort((a, b) => b.runDate.localeCompare(a.runDate))
        .slice(0, 6)
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async scheduleRun(payload: ScheduleRun): Promise<number> {
      const next: DevRun = {
        ...payload,
        status: 'waiting',
        confirmed: false,
        schemaRev: 3
      }
      const id = await db.runs.add(plain(next))
      await this.load()
      return id
    },
    async confirmRun(id: number, confirmed: boolean): Promise<void> {
      await db.runs.update(id, plain({ confirmed }))
      await this.load()
    },
    async startRun(id: number): Promise<void> {
      await db.transaction('rw', db.runs, db.recipes, db.developers, async () => {
        const run = await db.runs.get(id)
        if (!run) throw new Error('实冲批次不存在')
        if (run.status !== 'waiting') throw new Error('只有等待中的批次可以开冲')
        if (!run.confirmed) throw new Error('胶片批次或显影液变化后，请先重新确认再开冲')

        const recipe = await db.recipes.get(run.recipeId)
        if (!recipe || recipe.status !== 'published') throw new Error('请选择已发布的配方版本')

        await db.runs.update(id, plain({ status: 'in_progress' as RunStatus }))
        const developer = await db.developers.get(recipe.developerId)
        if (developer && developer.id !== undefined && developer.state !== '报废') {
          await db.developers.update(developer.id, plain({ usedRolls: developer.usedRolls + 1 }))
        }
      })
      await this.load()
    },
    async completeRun(id: number, payload: RunCompletion): Promise<void> {
      await db.transaction('rw', db.runs, async () => {
        const run = await db.runs.get(id)
        if (!run) throw new Error('实冲批次不存在')
        if (run.status !== 'in_progress') throw new Error('只有刚进罐的批次可以完成记录')
        await db.runs.update(id, plain({
          ...payload,
          status: 'completed' as RunStatus,
          confirmed: true
        }))
      })
      await this.load()
    }
  }
})
