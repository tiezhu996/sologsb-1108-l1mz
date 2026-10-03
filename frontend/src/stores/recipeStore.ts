import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import { calculateCompensatedMinutes } from '../hooks/useTempCompensate'
import { newPublishToken, publishRecipeDraft } from '../utils/recipeVersioning'
import type { DevRecipe, PushPull } from '../types/dev-recipe'
import type { Dilution } from '../types/developer'
import { useRunStore } from './runStore'

export type RecipeDraftInput = Omit<
  DevRecipe,
  'id' | 'recipeId' | 'version' | 'status' | 'publishToken' | 'publishedAt' | 'schemaRev'
>

export const useRecipeStore = defineStore('recipe', {
  state: () => ({
    recipes: [] as DevRecipe[],
    loading: false,
    filterFilmId: 'all' as number | 'all',
    filterDilution: 'all' as Dilution | 'all',
    filterPushPull: 'all' as PushPull | 'all',
    targetTempC: 20
  }),
  getters: {
    /** 已发布版本 */
    publishedRecipes: (state) => state.recipes.filter((recipe) => recipe.status === 'published'),
    /** 尚未发布的草稿（每个逻辑配方至多一条） */
    draftRecipes: (state) => state.recipes.filter((recipe) => recipe.status === 'draft'),
    /** 每个逻辑配方最新发布版本（速查与排期只读这一份） */
    currentRecipes(): DevRecipe[] {
      const latest = new Map<number, DevRecipe>()
      for (const recipe of this.publishedRecipes) {
        const existing = latest.get(recipe.recipeId)
        if (!existing || (recipe.version ?? 0) > (existing.version ?? 0)) {
          latest.set(recipe.recipeId, recipe)
        }
      }
      return [...latest.values()]
    },
    draftByRecipeId(): (recipeId: number) => DevRecipe | undefined {
      return (recipeId: number) => this.draftRecipes.find((recipe) => recipe.recipeId === recipeId)
    },
    versionsByRecipeId(): (recipeId: number) => DevRecipe[] {
      return (recipeId: number) => this.publishedRecipes
        .filter((recipe) => recipe.recipeId === recipeId)
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
    },
    filteredRecipes(): DevRecipe[] {
      return this.currentRecipes.filter((recipe) => {
        const matchesFilm = this.filterFilmId === 'all' || recipe.filmId === this.filterFilmId
        const matchesDilution = this.filterDilution === 'all' || recipe.dilution === this.filterDilution
        const matchesPushPull = this.filterPushPull === 'all' || recipe.pushPull === this.filterPushPull
        return matchesFilm && matchesDilution && matchesPushPull
      })
    },
    compensatedRecipes(): Array<DevRecipe & { compensatedMinutes: number }> {
      return this.filteredRecipes.map((recipe) => ({
        ...recipe,
        compensatedMinutes: calculateCompensatedMinutes(recipe.devMinutes, this.targetTempC, recipe.tempC)
      }))
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.recipes = await db.recipes.orderBy('id').toArray()
      } finally {
        this.loading = false
      }
    },
    /** 取逻辑配方指定版本（历史罐次用它读旧版） */
    getVersion(recipeId: number, version: number): DevRecipe | undefined {
      return this.publishedRecipes.find(
        (recipe) => recipe.recipeId === recipeId && recipe.version === version
      )
    },
    /** 新建配方：先落草稿，发布后才成为 v1 */
    async createDraft(payload: RecipeDraftInput): Promise<{ id: number; recipeId: number }> {
      const recipeId = (await db.recipes.orderBy('recipeId').reverse().first())?.recipeId ?? 0
      const logicalId = recipeId + 1
      const id = await db.recipes.add(plain({
        ...payload,
        recipeId: logicalId,
        status: 'draft',
        schemaRev: 3
      }))
      await this.load()
      return { id, recipeId: logicalId }
    },
    /** 编辑已有配方：保存为该配方的草稿，当前发布版本不变；编辑后旧的发布令牌作废 */
    async saveDraft(recipeId: number, payload: RecipeDraftInput, draftId?: number): Promise<number> {
      if (draftId !== undefined) {
        const existing = await db.recipes.get(draftId)
        if (existing) {
          // 整对象 put 以确保 pendingPublishToken 在重新编辑后被清除
          await db.recipes.put(plain({
            ...existing,
            ...payload,
            recipeId,
            status: 'draft',
            pendingPublishToken: undefined
          }))
        }
        await this.load()
        return draftId
      }
      const id = await db.recipes.add(plain({
        ...payload,
        recipeId,
        status: 'draft',
        schemaRev: 3
      }))
      await this.load()
      return id
    },
    /** 实冲结果回写：写入草稿（不直接改已发布版本），没有草稿时以当前版为底稿新建 */
    async writeBackToDraft(recipeId: number, note: string): Promise<number> {
      const existing = this.draftByRecipeId(recipeId)
      if (existing?.id !== undefined) {
        await db.recipes.update(existing.id, plain({ note }))
        await this.load()
        return existing.id
      }
      const current = this.currentRecipes.find((recipe) => recipe.recipeId === recipeId)
      if (!current) throw new Error('配方不存在')
      const id = await db.recipes.add(plain({
        recipeId,
        status: 'draft',
        filmId: current.filmId,
        developerId: current.developerId,
        dilution: current.dilution,
        tempC: current.tempC,
        devMinutes: current.devMinutes,
        agitation: current.agitation,
        stopBath: current.stopBath,
        fixer: current.fixer,
        washMinutes: current.washMinutes,
        pushPull: current.pushPull,
        note,
        schemaRev: 3
      } satisfies DevRecipe))
      await this.load()
      return id
    },
    async discardDraft(draftId: number): Promise<void> {
      await db.recipes.delete(draftId)
      await this.load()
    },
    /**
     * 发布草稿。
     * 幂等策略：首次发起时把令牌持久化到草稿的 pendingPublishToken 上；
     * 若发布结果未明（如进程中断），再次点击发布会沿用同一令牌，不重复生成版本。
     * 草稿被重新编辑保存后令牌作废，会签发新令牌。
     * 发布过程失败时草稿与等待实冲的确认结果都保留在数据库中。
     */
    async publishDraft(draftId: number): Promise<{ version: number; reconfirmedRunIds: number[]; retried: boolean }> {
      const draftBefore = await db.recipes.get(draftId)
      if (!draftBefore || draftBefore.status !== 'draft') {
        throw new Error('待发布的配方草稿不存在')
      }
      // 复用上次发起但结果未明的令牌；否则签发新令牌并先落库
      const publishToken = draftBefore.pendingPublishToken ?? newPublishToken()
      if (draftBefore.pendingPublishToken !== publishToken) {
        await db.recipes.update(draftId, plain({ pendingPublishToken: publishToken }))
      }
      try {
        const result = await publishRecipeDraft(draftId, publishToken)
        await Promise.all([this.load(), useRunStore().load()])
        return { version: result.version, reconfirmedRunIds: result.reconfirmedRunIds, retried: result.retried }
      } catch (error) {
        // 令牌已随草稿保留，再次点击发布即等价于重试，不会重复生成版本
        await this.load()
        throw error
      }
    }
  }
})
