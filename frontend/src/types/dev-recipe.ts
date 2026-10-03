import type { Dilution } from './developer'

export type PushPull = '-1' | 'N' | '+1' | '+2'
export type RecipeStatus = 'published' | 'draft'

export interface DevRecipe {
  id?: number
  groupId?: number
  version: number
  status: RecipeStatus
  filmId: number
  developerId: number
  dilution: Dilution
  tempC: number
  devMinutes: number
  agitation: string
  stopBath: string
  fixer: string
  washMinutes: number
  pushPull: PushPull
  note?: string
  publishedAt?: string
  updatedAt?: string
  schemaRev?: number
}

export type RecipeDraftPayload = Omit<
  DevRecipe,
  'id' | 'groupId' | 'version' | 'status' | 'publishedAt' | 'schemaRev'
>
