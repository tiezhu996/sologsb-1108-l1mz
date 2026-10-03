<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import { useTempCompensate } from '../hooks/useTempCompensate'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useRunStore } from '../stores/runStore'
import type { DevRun, TankType } from '../types/dev-run'

type StatusFilter = 'all' | 'waiting' | 'in_progress' | 'completed'

interface RunForm {
  batchNo: string
  recipeId: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
}

const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()
const showForm = ref(false)
const saving = ref(false)
const actingRunId = ref<number | null>(null)
const statusFilter = ref<StatusFilter>('all')
const keyword = ref('')
const today = new Date().toISOString().slice(0, 10)
const completionForms = reactive<Record<number, { actualTempC: number; actualMinutes: number; tankType: TankType; result: string }>>({})

const form = reactive<RunForm>({
  batchNo: `R-${today.replace(/-/g, '')}-01`,
  recipeId: 1,
  actualTempC: 20,
  actualMinutes: 8,
  tankType: '双联罐',
  runDate: today,
  result: '密度均匀，中间调细腻'
})

const recipeOptions = computed(() => recipeStore.latestPublishedRecipes)
const selectedRecipe = computed(() => recipeStore.getRecipeById(form.recipeId) ?? recipeOptions.value[0])
const referenceTemp = computed(() => selectedRecipe.value?.tempC ?? 20)
const { suggest } = useTempCompensate(referenceTemp)
const suggestion = computed(() => {
  const recipe = selectedRecipe.value
  if (!recipe || recipe.status !== 'published') return null
  return suggest(recipe.devMinutes, form.actualTempC)
})

watch(selectedRecipe, (recipe) => {
  if (!recipe) return
  form.recipeId = recipe.id ?? form.recipeId
  form.actualTempC = recipe.tempC
  form.actualMinutes = recipe.devMinutes
}, { immediate: true })

const filteredRuns = computed(() => {
  const word = keyword.value.trim().toLowerCase()
  return runStore.runs.filter((run) => {
    const recipe = recipeStore.getRecipeById(run.recipeId)
    const film = filmStore.films.find((item) => item.id === recipe?.filmId)
    const haystack = `${run.batchNo} ${run.result ?? ''} ${film?.model ?? ''}`.toLowerCase()
    const matchesStatus = statusFilter.value === 'all' || run.status === statusFilter.value
    const matchesKeyword = !word || haystack.includes(word)
    return matchesStatus && matchesKeyword
  })
})

const waitingCount = computed(() => runStore.runs.filter((run) => run.status === 'waiting').length)
const inProgressCount = computed(() => runStore.runs.filter((run) => run.status === 'in_progress').length)
const completedCount = computed(() => runStore.completedRuns.length)
const needConfirmationCount = computed(() => runStore.runs.filter((run) => run.status === 'waiting' && !run.confirmed).length)

function filmLabel(id: number | undefined): string {
  const film = filmStore.films.find((item) => item.id === id)
  return film ? `${film.model} · ${film.format} · ${film.emulsionNo}` : '未知胶片批次'
}

function developerLabel(id: number | undefined): string {
  const developer = developerStore.developers.find((item) => item.id === id)
  return developer ? `${developer.name} · ${developer.category}` : '未知显影液'
}

function recipeLabel(id: number): string {
  const recipe = recipeStore.getRecipeById(id)
  if (!recipe) return '未知配方版本'
  return `${filmLabel(recipe.filmId)} · ${developerLabel(recipe.developerId)} · v${recipe.version} · ${recipe.tempC}°C`
}

function recipeForRun(run: DevRun) {
  return recipeStore.getRecipeById(run.recipeId)
}

function statusLabel(status: DevRun['status']): string {
  return { waiting: '等待中', in_progress: '刚进罐', completed: '已完成' }[status]
}

function statusClass(status: DevRun['status']): string {
  return { waiting: 'status--warning', in_progress: 'status--cyan', completed: 'status--ok' }[status]
}

function ensureCompletionForm(run: DevRun): void {
  if (run.id === undefined || completionForms[run.id]) return
  const recipe = recipeStore.getRecipeById(run.recipeId)
  completionForms[run.id] = {
    actualTempC: run.actualTempC ?? recipe?.tempC ?? 20,
    actualMinutes: run.actualMinutes ?? recipe?.devMinutes ?? 8,
    tankType: run.tankType ?? '双联罐',
    result: ''
  }
}

function applySuggestion(): void {
  if (!suggestion.value) return
  form.actualMinutes = suggestion.value.minutes
}

function developerUsageMessage(recipeId: number): string {
  const recipe = recipeStore.getRecipeById(recipeId)
  const developer = developerStore.developers.find((item) => item.id === recipe?.developerId)
  if (developer && developer.state !== '报废' && developer.usedRolls > developer.maxRolls) {
    return '本次已超过显影液标称可冲上限，请评估后标记报废'
  }
  return '显影液用量已同步更新'
}

function validateSchedule(): boolean {
  if (!form.batchNo.trim() || !form.recipeId) {
    ElMessage.warning('请填写批次号并选择已发布配方')
    return false
  }
  if (!selectedRecipe.value || selectedRecipe.value.status !== 'published') {
    ElMessage.warning('请选择已发布配方版本')
    return false
  }
  return true
}

async function schedule(): Promise<void> {
  if (!validateSchedule()) return
  saving.value = true
  try {
    await runStore.scheduleRun({
      batchNo: form.batchNo.trim(),
      recipeId: Number(form.recipeId),
      runDate: form.runDate
    })
    ElMessage.success('已排入等待；配方或物料变化时需重新确认，未确认不能开冲')
    form.batchNo = `R-${today.replace(/-/g, '')}-${String(runStore.runs.length + 1).padStart(2, '0')}`
    showForm.value = false
  } finally {
    saving.value = false
  }
}

async function recordCompleted(): Promise<void> {
  if (!validateSchedule()) return
  if (!form.result.trim()) {
    ElMessage.warning('请填写结果评价')
    return
  }
  saving.value = true
  try {
    const id = await runStore.scheduleRun({
      batchNo: form.batchNo.trim(),
      recipeId: Number(form.recipeId),
      runDate: form.runDate
    })
    await runStore.confirmRun(id, true)
    await runStore.startRun(id)
    await runStore.completeRun(id, {
      actualTempC: Number(form.actualTempC),
      actualMinutes: Number(form.actualMinutes),
      tankType: form.tankType,
      result: form.result.trim()
    })
    await developerStore.load()
    const usageMessage = developerUsageMessage(Number(form.recipeId))
    if (usageMessage.includes('超过')) {
      ElMessage.warning(`完成罐次已保存，${usageMessage}`)
    } else {
      ElMessage.success('完成罐次已保存，并永久绑定当时使用的配方版本')
    }
    form.batchNo = `R-${today.replace(/-/g, '')}-${String(runStore.runs.length + 1).padStart(2, '0')}`
    form.result = ''
    showForm.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function toggleConfirm(run: DevRun): Promise<void> {
  if (run.id === undefined || run.status !== 'waiting') return
  actingRunId.value = run.id
  try {
    await runStore.confirmRun(run.id, !run.confirmed)
  } finally {
    actingRunId.value = null
  }
}

async function start(run: DevRun): Promise<void> {
  if (run.id === undefined) return
  actingRunId.value = run.id
  try {
    await runStore.startRun(run.id)
    await developerStore.load()
    const usageMessage = developerUsageMessage(run.recipeId)
    ElMessage.success(`已开冲；本罐继续使用开冲时确认的配方版本，${usageMessage}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '开冲失败')
  } finally {
    actingRunId.value = null
  }
}

async function complete(run: DevRun): Promise<void> {
  if (run.id === undefined) return
  const values = completionForms[run.id]
  if (!values?.result.trim()) {
    ElMessage.warning('请填写本次结果评价')
    return
  }
  actingRunId.value = run.id
  try {
    await runStore.completeRun(run.id, {
      actualTempC: Number(values.actualTempC),
      actualMinutes: Number(values.actualMinutes),
      tankType: values.tankType,
      result: values.result.trim()
    })
    ElMessage.success('罐次已完成，历史记录不会随后续配方发布改变')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '完成失败')
  } finally {
    actingRunId.value = null
  }
}

async function writeBackDraft(run: DevRun): Promise<void> {
  if (run.id === undefined) return
  const values = completionForms[run.id]
  const note = `${run.runDate} 实冲 ${values?.actualTempC ?? run.actualTempC}°C / ${values?.actualMinutes ?? run.actualMinutes} 分钟：${run.result}`
  try {
    await recipeStore.startRevisionFromNote(run.recipeId, note)
    ElMessage.success('已生成下一版配方草稿，确认发布后才影响等待中的实冲')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成草稿失败')
  }
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load(), runStore.load()])
  if (recipeOptions.value[0]?.id !== undefined) form.recipeId = recipeOptions.value[0].id
  runStore.runs.forEach((run) => {
    if (run.status === 'in_progress') ensureCompletionForm(run)
  })
})

watch(() => runStore.runs, (runs) => {
  runs.filter((run) => run.status === 'in_progress').forEach(ensureCompletionForm)
}, { deep: true })
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">RUN JOURNAL</span>
        <h1>冲洗排期与结果评价</h1>
        <p>等待罐次确认后才能开冲。新版配方发布后，等待中改用新版，刚进罐和历史罐次继续读取当时版本。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-run" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '新建实冲' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-run" @submit.prevent="schedule">
      <div class="inline-form__head">
        <div>
          <h2>排入待冲或补录完成罐次</h2>
          <p>选择的是当前最新已发布版本。排入等待后，若胶片批次或显影液变化，需要重新确认。</p>
        </div>
        <PushPullTag v-if="selectedRecipe" :value="selectedRecipe.pushPull" show-hint />
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>批次号</span>
          <input v-model="form.batchNo" data-testid="field-batchNo" type="text" />
        </label>
        <label class="span-2">
          <span>冲洗配方（最新发布版）</span>
          <select v-model.number="form.recipeId" data-testid="field-recipeId">
            <option v-for="recipe in recipeOptions" :key="recipe.id" :value="recipe.id">
              配方组 #{{ recipe.groupId }} · v{{ recipe.version }} · {{ filmLabel(recipe.filmId) }} · {{ developerLabel(recipe.developerId) }}
            </option>
          </select>
        </label>
        <label>
          <span>计划/冲洗日期</span>
          <input v-model="form.runDate" data-testid="field-runDate" type="date" />
        </label>
        <label>
          <span>实测温度（补录时填写）</span>
          <input v-model.number="form.actualTempC" data-testid="field-actualTempC" type="number" min="10" max="50" step="0.1" />
        </label>
        <label>
          <span>实际时间（补录时填写）</span>
          <input v-model.number="form.actualMinutes" data-testid="field-actualMinutes" type="number" min="0.25" max="90" step="0.25" />
        </label>
        <label>
          <span>罐型（补录时填写）</span>
          <select v-model="form.tankType" data-testid="field-tankType">
            <option value="双联罐">双联罐</option>
            <option value="深罐">深罐</option>
          </select>
        </label>
        <label class="span-3">
          <span>结果评价（补录时填写）</span>
          <input v-model="form.result" data-testid="field-result" type="text" placeholder="等待排期可留空；完成罐次需记录反差、灰雾与密度表现" />
        </label>
        <div class="span-3 compensation-callout">
          <div>
            <strong>温度补偿建议</strong>
            <p v-if="suggestion">{{ suggestion.advice }}；开冲时才会增加一卷显影液用量。</p>
            <p v-else>请选择一条已发布配方后查看修正建议。</p>
          </div>
          <button type="button" class="ghost-button" :disabled="!suggestion" @click="applySuggestion">采用修正时间</button>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="ghost-button" data-testid="submit-waiting-run" :disabled="saving">排入等待</button>
        <button type="button" class="primary-button" data-testid="submit-run" :disabled="saving" @click="recordCompleted">保存完成罐次</button>
      </div>
    </form>

    <div class="stat-strip">
      <div class="simple-stat"><span>等待中</span><strong>{{ waitingCount }}</strong><small>罐</small></div>
      <div class="simple-stat"><span>刚进罐</span><strong>{{ inProgressCount }}</strong><small>罐</small></div>
      <div class="simple-stat"><span>已完成</span><strong data-testid="count-run">{{ completedCount }}</strong><small>次</small></div>
      <div class="simple-stat"><span>待重新确认</span><strong>{{ needConfirmationCount }}</strong><small>罐</small></div>
    </div>

    <div class="panel run-toolbar">
      <div class="status-tabs" role="group" aria-label="按状态筛选">
        <button type="button" :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">全部 {{ runStore.runs.length }}</button>
        <button type="button" :class="{ active: statusFilter === 'waiting' }" @click="statusFilter = 'waiting'">等待中 {{ waitingCount }}</button>
        <button type="button" :class="{ active: statusFilter === 'in_progress' }" @click="statusFilter = 'in_progress'">刚进罐 {{ inProgressCount }}</button>
        <button type="button" :class="{ active: statusFilter === 'completed' }" @click="statusFilter = 'completed'">已完成 {{ completedCount }}</button>
      </div>
      <input v-model="keyword" type="search" placeholder="搜索批次、胶片型号或结果" />
    </div>

    <div v-if="filteredRuns.length" class="run-list">
      <article v-for="run in filteredRuns" :key="run.id" class="run-card" data-testid="row-run">
        <div class="run-card__date">
          <strong>{{ run.runDate.slice(5) }}</strong>
          <span>{{ run.runDate.slice(0, 4) }}</span>
        </div>
        <div class="run-card__body">
          <div class="entity-card__title">
            <div>
              <h2>{{ run.batchNo }}</h2>
              <p>{{ recipeLabel(run.recipeId) }}</p>
            </div>
            <div class="run-card__badges">
              <span class="status-chip" :class="statusClass(run.status)">{{ statusLabel(run.status) }}</span>
              <span v-if="run.status === 'waiting'" class="status-chip" :class="run.confirmed ? 'status--ok' : 'status--rose'">
                {{ run.confirmed ? '已确认' : '待确认' }}
              </span>
              <PushPullTag v-if="recipeForRun(run)" :value="recipeForRun(run)?.pushPull ?? 'N'" />
            </div>
          </div>

          <div v-if="run.status === 'waiting'" class="waiting-callout" :class="{ 'waiting-callout--alert': !run.confirmed }">
            <div>
              <strong>{{ run.confirmed ? '可以开冲' : '不能开冲：请先确认配方依据' }}</strong>
              <p v-if="run.confirmed">本罐将使用当前绑定的已发布版本；开冲后即使再发布新版也不会改动。</p>
              <p v-else>胶片批次或显影液发生变化，请核对新配方后重新确认。</p>
            </div>
            <div class="run-actions">
              <button
                type="button"
                class="ghost-button"
                data-testid="confirm-run"
                :disabled="actingRunId === run.id"
                @click="toggleConfirm(run)"
              >{{ run.confirmed ? '撤回确认' : '重新确认' }}</button>
              <button
                type="button"
                class="primary-button"
                data-testid="start-run"
                :disabled="!run.confirmed || actingRunId === run.id"
                @click="start(run)"
              >{{ actingRunId === run.id ? '处理中…' : '开冲进罐' }}</button>
            </div>
          </div>

          <template v-else>
            <div class="run-parameters">
              <span v-if="run.actualTempC !== undefined"><small>实测温度</small><strong>{{ run.actualTempC }}°C</strong></span>
              <span v-if="run.actualMinutes !== undefined"><small>实际时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
              <span v-if="run.tankType"><small>罐型</small><strong>{{ run.tankType }}</strong></span>
              <span><small>配方版本</small><strong>v{{ recipeForRun(run)?.version ?? '?' }}</strong></span>
            </div>
            <blockquote v-if="run.result">{{ run.result }}</blockquote>
          </template>

          <form
            v-if="run.status === 'in_progress' && run.id !== undefined && completionForms[run.id]"
            class="completion-form"
            @submit.prevent="complete(run)"
          >
            <label>
              <span>实测温度</span>
              <input v-model.number="completionForms[run.id].actualTempC" type="number" step="0.1" />
            </label>
            <label>
              <span>实际时间</span>
              <input v-model.number="completionForms[run.id].actualMinutes" type="number" step="0.25" />
            </label>
            <label>
              <span>罐型</span>
              <select v-model="completionForms[run.id].tankType">
                <option value="双联罐">双联罐</option>
                <option value="深罐">深罐</option>
              </select>
            </label>
            <label class="wide">
              <span>结果评价</span>
              <input v-model="completionForms[run.id].result" placeholder="填写反差、灰雾与密度表现" />
            </label>
            <div class="form-actions">
              <button type="submit" class="primary-button" data-testid="complete-run" :disabled="actingRunId === run.id">
                {{ actingRunId === run.id ? '保存中…' : '完成本罐' }}
              </button>
            </div>
          </form>

          <div class="run-card__foot">
            <small v-if="recipeForRun(run)?.note">该版本注释：{{ recipeForRun(run)?.note }}</small>
            <button
              v-if="run.status === 'completed'"
              type="button"
              class="text-button"
              data-testid="write-back-draft"
              @click="writeBackDraft(run)"
            >将结果生成下一版草稿</button>
          </div>
        </div>
      </article>
    </div>
    <EmptyPanel v-else title="没有符合条件的实冲罐次" description="切换状态、修改关键字，或新建一条等待排期。" />
  </section>
</template>

<style scoped>
.run-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
}

.run-toolbar input {
  flex: 1 1 230px;
  min-width: 200px;
  height: 39px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: #fffdf9;
}

.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.status-tabs button {
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--ink-soft);
  background: #fffdf9;
  cursor: pointer;
}

.status-tabs button.active {
  border-color: var(--accent);
  color: #fff8ec;
  background: var(--accent);
}

.run-card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.waiting-callout {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border: 1px solid #d9c39d;
  border-radius: 12px;
  background: #fbf2df;
}

.waiting-callout--alert {
  border-color: #d79a8f;
  background: #fbe9e4;
}

.waiting-callout strong {
  display: block;
  margin-bottom: 3px;
  font-size: 13px;
}

.waiting-callout p {
  margin: 0;
  color: var(--ink-soft);
  font-size: 11px;
}

.run-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

.completion-form {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
  border: 1px solid #bcd8d8;
  border-radius: 12px;
  background: #f2f9f8;
}

.completion-form label {
  display: grid;
  gap: 5px;
  color: var(--ink-soft);
  font-size: 11px;
}

.completion-form input,
.completion-form select {
  height: 36px;
  padding: 0 9px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: #fff;
}

.completion-form .wide,
.completion-form .form-actions {
  grid-column: span 2;
}

.completion-form .form-actions {
  align-items: end;
}

@media (max-width: 900px) {
  .waiting-callout {
    align-items: stretch;
    flex-direction: column;
  }

  .run-actions {
    justify-content: flex-end;
  }

  .completion-form {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 560px) {
  .completion-form {
    grid-template-columns: 1fr;
  }

  .completion-form .wide,
  .completion-form .form-actions {
    grid-column: span 1;
  }
}
</style>
