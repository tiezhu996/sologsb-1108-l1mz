import type { Dilution } from './developer'

export type PushPull = '-1' | 'N' | '+1' | '+2'

/** 配方行生命周期：草稿只用于编辑，发布版才会被排期引用 */
export type RecipeVersionStatus = 'draft' | 'published'

export interface DevRecipe {
  id?: number
  /** 同一配方的逻辑标识，多个版本（含草稿）共享同一个 recipeId */
  recipeId: number
  /** 版本号，草稿阶段为空，发布时确定 */
  version?: number
  status: RecipeVersionStatus
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
  /** 每次发起发布生成的幂等令牌；重试同一令牌不会重复生成版本 */
  publishToken?: string
  /** 已点击发布但结果未明时挂在草稿上的令牌，重试发布沿用它；草稿再编辑后清除 */
  pendingPublishToken?: string
  publishedAt?: string
  schemaRev?: number
}

/** 配方版本相对上一版的物料变化，用于判断等待中的实冲是否需要重新确认 */
export interface MaterialChange {
  filmChanged: boolean
  developerChanged: boolean
}
