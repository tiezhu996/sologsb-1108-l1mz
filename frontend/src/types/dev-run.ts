export type TankType = '双联罐' | '深罐'
export type RunStatus = 'waiting' | 'in_progress' | 'completed'

export interface DevRun {
  id?: number
  batchNo: string
  recipeId: number
  status: RunStatus
  confirmed: boolean
  actualTempC?: number
  actualMinutes?: number
  tankType?: TankType
  runDate: string
  result?: string
  schemaRev?: number
}

export interface RunCompletion {
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  result: string
}
