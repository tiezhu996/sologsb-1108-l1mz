import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import { calculateCompensatedMinutes } from '../hooks/useTempCompensate'
import type { DevRecipe, RecipeDraftPayload } from '../types/dev-recipe'
import type { Dilution } from '../types/developer'
import type { PushPull } from '../types/dev-recipe'

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
    publishedRecipes: (state) => state.recipes
      .filter((recipe) => recipe.status === 'published')
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')),
    latestPublishedRecipes(): DevRecipe[] {
      const latestByGroup = new Map<number, DevRecipe>()
      this.publishedRecipes.forEach((recipe) => {
        const groupId = recipe.groupId ?? recipe.id ?? 0
        const current = latestByGroup.get(groupId)
        if (!current || recipe.version > current.version) {
          latestByGroup.set(groupId, recipe)
        }
      })
      return [...latestByGroup.values()].sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
    },
    draftRecipes: (state) => state.recipes
      .filter((recipe) => recipe.status === 'draft')
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    filteredRecipes(): DevRecipe[] {
      return this.latestPublishedRecipes.filter((recipe) => {
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
    },
    getRecipeById: (state) => (id: number): DevRecipe | undefined =>
      state.recipes.find((recipe) => recipe.id === id),
    getLatestPublished: (state) => (groupId: number): DevRecipe | undefined =>
      state.recipes
        .filter((recipe) => recipe.status === 'published' && (recipe.groupId ?? recipe.id) === groupId)
        .sort((a, b) => b.version - a.version)[0],
    getDraftByGroup: (state) => (groupId: number): DevRecipe | undefined =>
      state.recipes.find((recipe) => recipe.status === 'draft' && recipe.groupId === groupId)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.recipes = await db.recipes.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async saveDraft(payload: RecipeDraftPayload & { draftId?: number; groupId?: number }): Promise<number> {
      const now = new Date().toISOString()
      if (payload.draftId !== undefined) {
        const changes: Partial<DevRecipe> & { draftId?: number; groupId?: number } = { ...payload, updatedAt: now }
        delete changes.id
        delete changes.draftId
        delete changes.groupId
        await db.recipes.update(payload.draftId, plain(changes))
        await this.load()
        return payload.draftId
      }

      if (payload.groupId !== undefined) {
        const existingDraft = await db.recipes
          .where('groupId').equals(payload.groupId)
          .filter((recipe) => recipe.status === 'draft')
          .first()
        if (existingDraft?.id !== undefined) return existingDraft.id
      }

      const allRecipes = await db.recipes.toArray()
      const nextGroupId = payload.groupId
        ?? Math.max(0, ...allRecipes.map((recipe) => recipe.groupId ?? recipe.id ?? 0)) + 1
      const { draftId: _draftId, groupId: _groupId, ...recipePayload } = payload
      void _draftId
      void _groupId
      const draft: DevRecipe = {
        ...recipePayload,
        groupId: nextGroupId,
        version: 0,
        status: 'draft',
        updatedAt: now,
        schemaRev: 3
      }
      const id = await db.recipes.add(plain(draft))
      await this.load()
      return id
    },
    async publishDraft(draftId: number): Promise<number> {
      const draft = await db.recipes.get(draftId)
      if (!draft || draft.status !== 'draft') {
        throw new Error('待发布的配方草稿不存在')
      }

      const groupId = draft.groupId ?? draftId
      const publishedId = await db.transaction('rw', db.recipes, db.runs, async () => {
        const groupVersions = await db.recipes
          .where('groupId').equals(groupId)
          .filter((recipe) => recipe.status === 'published')
          .toArray()
        const groupPublished = groupVersions.sort((a, b) => b.version - a.version)
        const previous = groupPublished[0]
        const nextVersion = previous ? previous.version + 1 : 1
        const publishedAt = new Date().toISOString()
        const published: DevRecipe = {
          ...draft,
          id: undefined,
          groupId,
          version: nextVersion,
          status: 'published',
          publishedAt,
          updatedAt: undefined,
          schemaRev: 3
        }
        const id = await db.recipes.add(plain(published))

        const previousIds = groupPublished.map((item) => item.id).filter((item): item is number => item !== undefined)
        if (previousIds.length > 0) {
          const waitingRuns = await db.runs
            .where('recipeId').anyOf(previousIds)
            .filter((run) => run.status === 'waiting')
            .toArray()
          await Promise.all(waitingRuns.map((run) => {
            const boundRecipe = groupPublished.find((item) => item.id === run.recipeId)
            const variantChanged = !boundRecipe
              || draft.filmId !== boundRecipe.filmId
              || draft.developerId !== boundRecipe.developerId
            return db.runs.update(run.id!, {
              recipeId: id,
              confirmed: variantChanged ? false : run.confirmed
            })
          }))
        }

        await db.recipes.delete(draftId)
        return id
      })
      await this.load()
      return publishedId
    },
    async discardDraft(draftId: number): Promise<void> {
      await db.recipes.delete(draftId)
      await this.load()
    },
    async startRevisionFromNote(recipeId: number, note: string): Promise<number> {
      const recipe = await db.recipes.get(recipeId)
      if (!recipe) throw new Error('配方不存在')
      const groupId = recipe.groupId ?? recipeId
      const existingDraft = await db.recipes
        .where('groupId').equals(groupId)
        .filter((item) => item.status === 'draft')
        .first()
      if (existingDraft?.id !== undefined) {
        await db.recipes.update(existingDraft.id, { note })
        await this.load()
        return existingDraft.id
      }

      const draft: DevRecipe = {
        ...recipe,
        id: undefined,
        groupId,
        version: 0,
        status: 'draft',
        note,
        publishedAt: undefined,
        updatedAt: new Date().toISOString(),
        schemaRev: 3
      }
      const id = await db.recipes.add(plain(draft))
      await this.load()
      return id
    }
  }
})
