<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import FilterBar from '../components/common/FilterBar.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import { useTempCompensate } from '../hooks/useTempCompensate'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useRunStore } from '../stores/runStore'
import type { DevRun, TankType } from '../types/dev-run'

interface FilterValue {
  keyword: string
  selections: Record<string, string[]>
}

interface ScheduleForm {
  batchNo: string
  recipeId: number
  tankType: TankType
  runDate: string
}

interface CompleteForm {
  actualTempC: number
  actualMinutes: number
  result: string
  runDate: string
}

const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()
const showForm = ref(false)
const saving = ref(false)
const workingRunId = ref<number | null>(null)
const today = new Date().toISOString().slice(0, 10)

const filterValue = ref<FilterValue>({
  keyword: '',
  selections: {
    tankType: [],
    status: [],
    result: []
  }
})

const form = reactive<ScheduleForm>({
  batchNo: `R-${today.replace(/-/g, '')}-01`,
  recipeId: 1,
  tankType: '双联罐',
  runDate: today
})

const currentOf = (recipeId: number) => recipeStore.currentRecipes.find((recipe) => recipe.recipeId === recipeId)

const selectedRecipe = computed(() => currentOf(form.recipeId))
const referenceTemp = computed(() => selectedRecipe.value?.tempC ?? 20)
const { suggest } = useTempCompensate(referenceTemp)

/** 按实冲绑定的版本号读取当时配方（历史罐次读旧版） */
function pinnedRecipe(run: DevRun) {
  return recipeStore.getVersion(run.recipeId, run.recipeVersion)
}

const completeForm = reactive<CompleteForm>({
  actualTempC: 20,
  actualMinutes: 8,
  result: '',
  runDate: today
})

function filmLabel(id: number): string {
  const film = filmStore.films.find((item) => item.id === id)
  return film ? `${film.model} · ${film.format} · ${film.emulsionNo}` : '未知胶片批次'
}

function developerLabel(id: number): string {
  const developer = developerStore.developers.find((item) => item.id === id)
  return developer ? `${developer.name} · ${developer.category}` : '未知显影液'
}

function recipeVersionLabel(run: DevRun): string {
  const recipe = pinnedRecipe(run)
  if (!recipe) return `配方 #${run.recipeId} v${run.recipeVersion}（版本缺失）`
  return `${filmLabel(recipe.filmId)} · ${developerLabel(recipe.developerId)} · v${run.recipeVersion} · ${recipe.tempC}°C`
}

const filteredRuns = computed(() => {
  const keyword = filterValue.value.keyword.trim().toLowerCase()
  const tankTypes = filterValue.value.selections.tankType ?? []
  const statuses = filterValue.value.selections.status ?? []
  const results = filterValue.value.selections.result ?? []
  return runStore.runs.filter((run) => {
    const recipe = pinnedRecipe(run)
    const haystack = `${run.batchNo} ${run.result} ${recipe ? filmLabel(recipe.filmId) : ''}`.toLowerCase()
    const matchesKeyword = !keyword || haystack.includes(keyword)
    const matchesTank = tankTypes.length === 0 || tankTypes.includes(run.tankType)
    const matchesStatus = statuses.length === 0 || statuses.includes(statusText(run.status))
    const matchesResult = results.length === 0 || results.some((item) => run.result.includes(item))
    return matchesKeyword && matchesTank && matchesStatus && matchesResult
  })
})

function statusText(status: DevRun['status']): string {
  return status === 'waiting' ? '等待开冲' : status === 'in_progress' ? '进行中' : '已完成'
}

function suggestionFor(run: DevRun, temp: number) {
  const recipe = pinnedRecipe(run)
  if (!recipe) return null
  return suggest(recipe.devMinutes, temp)
}

async function submitSchedule(): Promise<void> {
  if (!form.batchNo.trim() || !form.recipeId) {
    ElMessage.warning('请填写批次号并选择已发布的配方版本')
    return
  }
  saving.value = true
  try {
    await runStore.scheduleRun({
      batchNo: form.batchNo.trim(),
      recipeId: Number(form.recipeId),
      tankType: form.tankType,
      runDate: form.runDate
    })
    ElMessage.success('已排入等待，按当前配方版本排期，请确认物料后开冲')
    form.batchNo = `R-${today.replace(/-/g, '')}-${String(runStore.runs.length + 1).padStart(2, '0')}`
    showForm.value = false
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function confirmRun(run: DevRun): Promise<void> {
  if (run.id === undefined) return
  await runStore.confirmRun(run.id)
  ElMessage.success('已确认，可以开冲')
}

async function startRun(run: DevRun): Promise<void> {
  if (run.id === undefined) return
  if (!run.confirmed) {
    ElMessage.warning('该实冲因胶片批次或显影液变化需要重新确认，未确认不能开冲')
    return
  }
  try {
    await runStore.startRun(run.id)
    await developerStore.load()
    ElMessage.success('已开冲，配方版本固定，显影液用量加一卷')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

function openComplete(run: DevRun): void {
  if (run.id === undefined) return
  workingRunId.value = run.id
  const recipe = pinnedRecipe(run)
  completeForm.actualTempC = run.actualTempC
  completeForm.actualMinutes = run.actualMinutes
  completeForm.result = ''
  completeForm.runDate = run.runDate
  if (recipe) {
    const advice = suggestionFor(run, run.actualTempC)
    if (advice) completeForm.actualMinutes = advice.minutes
  }
}

async function submitComplete(): Promise<void> {
  if (workingRunId.value === null) return
  if (!completeForm.result.trim()) {
    ElMessage.warning('请填写结果评价后再完成罐次')
    return
  }
  saving.value = true
  try {
    await runStore.completeRun(workingRunId.value, { ...completeForm, result: completeForm.result.trim() })
    ElMessage.success('罐次已完成，结果按绑定版本归档')
    workingRunId.value = null
  } finally {
    saving.value = false
  }
}

async function switchMaterial(
  run: DevRun,
  patch: { filmId?: number; developerId?: number }
): Promise<void> {
  if (run.id === undefined || run.status !== 'waiting') return
  await runStore.changeWaitingMaterial(run.id, patch)
  ElMessage.warning('胶片批次/显影液已调整，等待中的实冲需重新确认后才能开冲')
}

async function writeBack(run: DevRun): Promise<void> {
  const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
  await recipeStore.writeBackToDraft(run.recipeId, note)
  ElMessage.success('本次实冲结果已写入配方草稿，发布后才会影响后续实冲')
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load(), runStore.load()])
  if (recipeStore.currentRecipes[0]?.recipeId !== undefined) {
    form.recipeId = recipeStore.currentRecipes[0].recipeId
  }
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">RUN JOURNAL</span>
        <h1>冲洗排期与罐次记录</h1>
        <p>等待开冲的实冲跟随已发布版本；换胶片批次或显影液须重新确认，未确认不能开冲。开冲后版本固定，历史罐次可追溯旧版。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-run" @click="showForm = !showForm">
        {{ showForm ? '收起排期' : '排入等待' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-run" @submit.prevent="submitSchedule">
      <div class="inline-form__head">
        <div>
          <h2>排入等待开冲</h2>
          <p>按配方当前发布版本排期，排入后需确认；发布新版本时等待中的实冲会换版。</p>
        </div>
        <PushPullTag v-if="selectedRecipe" :value="selectedRecipe.pushPull" show-hint />
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>批次号</span>
          <input v-model="form.batchNo" data-testid="field-batchNo" type="text" />
        </label>
        <label class="span-2">
          <span>配方（当前发布版）</span>
          <select v-model.number="form.recipeId" data-testid="field-recipeId">
            <option v-for="recipe in recipeStore.currentRecipes" :key="recipe.recipeId" :value="recipe.recipeId">
              {{ filmLabel(recipe.filmId) }} · {{ developerLabel(recipe.developerId) }} · v{{ recipe.version }} · {{ recipe.tempC }}°C
            </option>
          </select>
        </label>
        <label>
          <span>罐型</span>
          <select v-model="form.tankType" data-testid="field-tankType">
            <option value="双联罐">双联罐</option>
            <option value="深罐">深罐</option>
          </select>
        </label>
        <label>
          <span>计划日期</span>
          <input v-model="form.runDate" data-testid="field-runDate" type="date" />
        </label>
        <div class="span-3 compensation-callout">
          <div>
            <strong>排期基准</strong>
            <p v-if="selectedRecipe">v{{ selectedRecipe.version }}：{{ selectedRecipe.tempC }}°C / {{ selectedRecipe.devMinutes.toFixed(2) }} 分钟；排入后初始为「未确认」。</p>
            <p v-else>请选择一条已发布配方。</p>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-run" :disabled="saving">
          {{ saving ? '排入中…' : '排入等待' }}
        </button>
      </div>
    </form>

    <div class="stat-strip">
      <div class="simple-stat"><span>等待开冲</span><strong data-testid="count-waiting">{{ runStore.waitingRuns.length }}</strong><small>罐 · 待确认 {{ runStore.unconfirmedCount }}</small></div>
      <div class="simple-stat"><span>进行中</span><strong>{{ runStore.inProgressRuns.length }}</strong><small>罐 · 版本已固定</small></div>
      <div class="simple-stat"><span>已完成</span><strong data-testid="count-run">{{ runStore.completedRuns.length }}</strong><small>罐 · 读旧版追溯</small></div>
      <div class="simple-stat"><span>回写草稿</span><strong>{{ recipeStore.draftRecipes.length }}</strong><small>条 · 发布后生效</small></div>
    </div>

    <FilterBar
      v-model="filterValue"
      :fields="[
        { key: 'status', label: '状态', options: ['等待开冲', '进行中', '已完成'] },
        { key: 'tankType', label: '罐型', options: ['双联罐', '深罐'] },
        { key: 'result', label: '结果特点', options: ['密度均匀', '暗部略薄', '反差稍强', '高光保留', '灰雾'] }
      ]"
    />

    <section v-if="runStore.waitingRuns.length" class="run-stage">
      <h2 class="run-stage__title">等待开冲</h2>
      <div class="run-list">
        <article v-for="run in runStore.waitingRuns.filter((item) => filteredRuns.includes(item))" :key="run.id" class="run-card run-card--waiting" data-testid="row-waiting">
          <div class="run-card__date">
            <strong>{{ run.runDate.slice(5) }}</strong>
            <span>计划</span>
          </div>
          <div class="run-card__body">
            <div class="entity-card__title">
              <div>
                <h2>{{ run.batchNo }}</h2>
                <p>{{ recipeVersionLabel(run) }}</p>
              </div>
              <PushPullTag v-if="pinnedRecipe(run)" :value="pinnedRecipe(run)?.pushPull ?? 'N'" />
            </div>
            <div class="run-parameters">
              <label>
                <small>胶片批次</small>
                <select
                  :value="run.filmId"
                  data-testid="waiting-film"
                  @change="switchMaterial(run, { filmId: Number(($event.target as HTMLSelectElement).value) })"
                >
                  <option v-for="film in filmStore.films" :key="film.id" :value="film.id">{{ filmLabel(film.id ?? 0) }}</option>
                </select>
              </label>
              <label>
                <small>显影液工作液</small>
                <select
                  :value="run.developerId"
                  data-testid="waiting-developer"
                  @change="switchMaterial(run, { developerId: Number(($event.target as HTMLSelectElement).value) })"
                >
                  <option v-for="developer in developerStore.developers" :key="developer.id" :value="developer.id">{{ developerLabel(developer.id ?? 0) }}</option>
                </select>
              </label>
              <span><small>计划温度</small><strong>{{ run.actualTempC }}°C</strong></span>
              <span><small>计划时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
              <span><small>罐型</small><strong>{{ run.tankType }}</strong></span>
            </div>
            <div class="confirm-strip" :class="{ 'confirm-strip--pending': !run.confirmed }">
              <strong v-if="run.confirmed" class="confirm-ok">✓ 已确认{{ run.confirmedAt ? `（${new Date(run.confirmedAt).toLocaleString()}）` : '' }}</strong>
              <strong v-else class="confirm-pending" data-testid="unconfirmed-badge">待确认：物料或版本已变化，未确认不能开冲</strong>
              <small v-if="run.confirmedNote">{{ run.confirmedNote }}</small>
            </div>
            <div class="run-card__foot">
              <button type="button" class="text-button" data-testid="confirm-run" @click="confirmRun(run)">重新确认</button>
              <button
                type="button"
                class="primary-button"
                data-testid="start-run"
                :disabled="!run.confirmed"
                @click="startRun(run)"
              >开冲</button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section v-if="runStore.inProgressRuns.length" class="run-stage">
      <h2 class="run-stage__title">进行中（固定读旧版）</h2>
      <div class="run-list">
        <article v-for="run in runStore.inProgressRuns.filter((item) => filteredRuns.includes(item))" :key="run.id" class="run-card run-card--progress" data-testid="row-progress">
          <div class="run-card__date">
            <strong>{{ run.runDate.slice(5) }}</strong>
            <span>在冲</span>
          </div>
          <div class="run-card__body">
            <div class="entity-card__title">
              <div>
                <h2>{{ run.batchNo }}</h2>
                <p>{{ recipeVersionLabel(run) }}</p>
              </div>
              <PushPullTag v-if="pinnedRecipe(run)" :value="pinnedRecipe(run)?.pushPull ?? 'N'" />
            </div>
            <div class="run-parameters">
              <span><small>开冲温度</small><strong>{{ run.actualTempC }}°C</strong></span>
              <span><small>计划时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
              <span><small>罐型</small><strong>{{ run.tankType }}</strong></span>
              <span><small>开冲时间</small><strong>{{ run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : '—' }}</strong></span>
            </div>
            <div class="run-card__foot">
              <button type="button" class="primary-button" data-testid="complete-run" @click="openComplete(run)">录入结果并完成</button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section v-if="workingRunId !== null" class="panel complete-panel" data-testid="complete-form">
      <div class="panel__head">
        <div>
          <h2>完成罐次 #{{ workingRunId }}</h2>
          <p>结果归档后不可改版本，继续读绑定的旧版配方。</p>
        </div>
        <button type="button" class="text-button" @click="workingRunId = null">取消</button>
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>实测温度</span>
          <input v-model.number="completeForm.actualTempC" type="number" min="10" max="50" step="0.1" data-testid="complete-temp" />
        </label>
        <label>
          <span>实际时间</span>
          <input v-model.number="completeForm.actualMinutes" type="number" min="0.25" max="90" step="0.25" data-testid="complete-minutes" />
        </label>
        <label>
          <span>冲洗日期</span>
          <input v-model="completeForm.runDate" type="date" />
        </label>
        <label class="span-3">
          <span>结果评价</span>
          <input v-model="completeForm.result" type="text" placeholder="记录反差、灰雾与密度表现" data-testid="complete-result" />
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="primary-button" :disabled="saving" @click="submitComplete">保存完成</button>
      </div>
    </section>

    <section v-if="runStore.completedRuns.length" class="run-stage">
      <h2 class="run-stage__title">已完成罐次（历史归档）</h2>
      <div class="run-list">
        <article v-for="run in runStore.completedRuns.filter((item) => filteredRuns.includes(item))" :key="run.id" class="run-card" data-testid="row-run">
          <div class="run-card__date">
            <strong>{{ run.runDate.slice(5) }}</strong>
            <span>{{ run.runDate.slice(0, 4) }}</span>
          </div>
          <div class="run-card__body">
            <div class="entity-card__title">
              <div>
                <h2>{{ run.batchNo }}</h2>
                <p>{{ recipeVersionLabel(run) }}</p>
              </div>
              <PushPullTag v-if="pinnedRecipe(run)" :value="pinnedRecipe(run)?.pushPull ?? 'N'" />
            </div>
            <div class="run-parameters">
              <span><small>实测温度</small><strong>{{ run.actualTempC }}°C</strong></span>
              <span><small>实际时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
              <span><small>罐型</small><strong>{{ run.tankType }}</strong></span>
            </div>
            <blockquote>{{ run.result }}</blockquote>
            <div class="run-card__foot">
              <small v-if="pinnedRecipe(run)?.note">该版本注释：{{ pinnedRecipe(run)?.note }}</small>
              <button type="button" class="text-button" data-testid="writeback" @click="writeBack(run)">回写到下一版草稿</button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <EmptyPanel
      v-if="!runStore.runs.length"
      title="还没有排期或冲洗记录"
      description="先在配方表发布配方，再把计划罐次排入等待。"
    />
  </section>
</template>
