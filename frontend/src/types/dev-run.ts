export type TankType = '双联罐' | '深罐'

/** 实冲生命周期：等待开冲 → 进行中 → 已完成 */
export type RunStatus = 'waiting' | 'in_progress' | 'completed'

export interface DevRun {
  id?: number
  batchNo: string
  /** 逻辑配方标识（配方分组 id） */
  recipeId: number
  /** 绑定的配方版本：开冲后固定，历史罐次继续读旧版 */
  recipeVersion: number
  /** 等待中当前排期依据的胶片批次，发布新版随配方更新 */
  filmId: number
  /** 等待中当前排期依据的显影液工作液，发布新版随配方更新 */
  developerId: number
  status: RunStatus
  /** 等待中实冲是否已按当前物料/版本确认；未确认不能开冲 */
  confirmed: boolean
  /** 最近一次确认的依据，写入历史方便追溯 */
  confirmedAt?: string
  confirmedNote?: string
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  /** 等待中表示计划日期，开冲后表示实际冲洗日期 */
  runDate: string
  startedAt?: string
  result: string
  schemaRev?: number
}
