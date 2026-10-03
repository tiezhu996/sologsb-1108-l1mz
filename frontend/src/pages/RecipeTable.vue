<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import DilutionInput from '../components/common/DilutionInput.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import TimeTempCurve from '../components/common/TimeTempCurve.vue'
import { calculateCompensatedMinutes, useTempCompensate } from '../hooks/useTempCompensate'
import { useRecipeFilter } from '../hooks/useRecipeFilter'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useRecipeStore } from '../stores/recipeStore'
import type { Developer, Dilution } from '../types/developer'
import type { DevRecipe, PushPull, RecipeDraftPayload } from '../types/dev-recipe'

interface RecipeForm {
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
  note: string
}

const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const { filmId, dilution, pushPull, filteredRecipes, resetFilters } = useRecipeFilter()
const showForm = ref(false)
const saving = ref(false)
const publishing = ref(false)
const publishingId = ref<number | null>(null)
const editingDraftId = ref<number | undefined>()
const editingGroupId = ref<number | undefined>()
const sampleWorkingVolume = ref(300)
const referenceTemp = computed(() => filteredRecipes.value[0]?.tempC ?? 20)
const { actualTempC, suggest } = useTempCompensate(referenceTemp)

watch(referenceTemp, (value) => {
  actualTempC.value = value
}, { immediate: true })

const form = reactive<RecipeForm>({
  filmId: 1,
  developerId: 1,
  dilution: '1:1',
  tempC: 20,
  devMinutes: 8,
  agitation: '每 30s 摇 5s',
  stopBath: '酸性停显 1 分钟',
  fixer: '快速定影 5 分钟',
  washMinutes: 10,
  pushPull: 'N',
  note: ''
})

const formTitle = computed(() => {
  if (editingDraftId.value !== undefined) return '编辑配方草稿'
  if (editingGroupId.value !== undefined) return '为已发布配方建立新版草稿'
  return '新建配方草稿'
})

const curvePoints = computed(() => {
  const recipe = filteredRecipes.value[0]
  if (!recipe) return []
  return Array.from({ length: 13 }, (_, index) => {
    const temp = Math.round((recipe.tempC - 3 + index * 0.5) * 10) / 10
    return {
      tempC: temp,
      minutes: calculateCompensatedMinutes(recipe.devMinutes, temp, recipe.tempC)
    }
  })
})

const versionHistory = computed(() => recipeStore.publishedRecipes
  .slice()
  .sort((a, b) => (b.groupId ?? b.id ?? 0) - (a.groupId ?? a.id ?? 0) || b.version - a.version)
  .slice(0, 12))

function filmLabel(id: number): string {
  const film = filmStore.films.find((item) => item.id === id)
  return film ? `${film.model} · ${film.format} · ${film.emulsionNo}` : '未知胶片'
}

function developerLabel(id: number): string {
  const developer = developerStore.developers.find((item) => item.id === id)
  return developer ? `${developer.name} · ${developer.category}` : '未知显影液'
}

function suggestedFor(recipe: { devMinutes: number; tempC: number }): number {
  return suggest(recipe.devMinutes, actualTempC.value).minutes
}

function pickCurveTemp(temp: number): void {
  actualTempC.value = temp
}

function fillForm(recipe: DevRecipe): void {
  form.filmId = recipe.filmId
  form.developerId = recipe.developerId
  form.dilution = recipe.dilution
  form.tempC = recipe.tempC
  form.devMinutes = recipe.devMinutes
  form.agitation = recipe.agitation
  form.stopBath = recipe.stopBath
  form.fixer = recipe.fixer
  form.washMinutes = recipe.washMinutes
  form.pushPull = recipe.pushPull
  form.note = recipe.note ?? ''
}

function resetEditor(): void {
  editingDraftId.value = undefined
  editingGroupId.value = undefined
  Object.assign(form, {
    filmId: filmStore.films[0]?.id ?? 1,
    developerId: developerStore.developers.find((item: Developer) => item.state !== '报废')?.id ?? 1,
    dilution: '1:1',
    tempC: 20,
    devMinutes: 8,
    agitation: '每 30s 摇 5s',
    stopBath: '酸性停显 1 分钟',
    fixer: '快速定影 5 分钟',
    washMinutes: 10,
    pushPull: 'N',
    note: ''
  })
}

function openCreate(): void {
  resetEditor()
  showForm.value = true
}

function openEditor(recipe: DevRecipe): void {
  const groupId = recipe.groupId ?? recipe.id
  if (groupId !== undefined && recipe.status === 'published') {
    const draft = recipeStore.getDraftByGroup(groupId)
    if (draft) {
      fillForm(draft)
      editingDraftId.value = draft.id
      editingGroupId.value = groupId
      showForm.value = true
      return
    }
  }
  fillForm(recipe)
  editingDraftId.value = recipe.status === 'draft' ? recipe.id : undefined
  editingGroupId.value = groupId
  showForm.value = true
}

function deriveRecipe(recipe: DevRecipe): void {
  fillForm(recipe)
  editingDraftId.value = undefined
  editingGroupId.value = undefined
  form.note = `派生自配方组 #${recipe.groupId ?? recipe.id ?? '原记录'} v${recipe.version}${recipe.note ? `：${recipe.note}` : ''}`
  showForm.value = true
}

function buildPayload(): RecipeDraftPayload {
  return {
    filmId: Number(form.filmId),
    developerId: Number(form.developerId),
    dilution: form.dilution,
    tempC: Number(form.tempC),
    devMinutes: Number(form.devMinutes),
    agitation: form.agitation.trim() || '每 30s 摇 5s',
    stopBath: form.stopBath.trim() || '酸性停显 1 分钟',
    fixer: form.fixer.trim() || '快速定影 5 分钟',
    washMinutes: Number(form.washMinutes),
    pushPull: form.pushPull,
    note: form.note.trim()
  }
}

async function saveDraft(): Promise<number | undefined> {
  if (!form.filmId || !form.developerId || !form.devMinutes) {
    ElMessage.warning('请选择胶片、显影液并填写显影时间')
    return undefined
  }
  saving.value = true
  try {
    const draftId = await recipeStore.saveDraft({
      ...buildPayload(),
      draftId: editingDraftId.value,
      groupId: editingGroupId.value
    })
    ElMessage.success('配方草稿已保留，发布前不会改动等待中的实冲')
    editingDraftId.value = draftId
    if (editingGroupId.value === undefined) {
      editingGroupId.value = recipeStore.getRecipeById(draftId)?.groupId ?? draftId
    }
    showForm.value = false
    return draftId
  } finally {
    saving.value = false
  }
}

async function saveAndPublish(): Promise<void> {
  const draftId = await saveDraft()
  if (draftId === undefined) return
  await publishExistingDraft(draftId)
}

async function publishExistingDraft(draftId: number): Promise<void> {
  publishing.value = true
  publishingId.value = draftId
  try {
    await recipeStore.publishDraft(draftId)
    ElMessage.success('新版本已发布；等待中实冲改用新版，进行中和历史罐次保留旧版')
    if (editingDraftId.value === draftId) showForm.value = false
    resetEditor()
  } catch (error) {
    ElMessage.error(`发布失败，草稿与确认结果仍保留：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    publishing.value = false
    publishingId.value = null
  }
}

async function discardDraft(recipe: DevRecipe): Promise<void> {
  if (recipe.id === undefined) return
  if (!window.confirm('放弃这份草稿不会影响任何已发布版本，确认放弃？')) return
  await recipeStore.discardDraft(recipe.id)
  if (editingDraftId.value === recipe.id) {
    showForm.value = false
    resetEditor()
  }
  ElMessage.success('草稿已放弃')
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load()])
  resetEditor()
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">PROCESS RECIPES</span>
        <h1>配方表</h1>
        <p>配方按版本发布：修改先保存为草稿；新版发布后，等待中的实冲才切换，进罐和完成罐次继续读取旧版。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-recipe" @click="openCreate">
        {{ showForm ? '收起表单' : '新建配方' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-recipe" @submit.prevent="saveAndPublish">
      <div class="inline-form__head">
        <div>
          <h2>{{ formTitle }}</h2>
          <p>草稿不会覆盖任何已发布版本；发布时才生成新版本号。等待罐次若胶片批次或显影液变化，会自动回到未确认。</p>
        </div>
      </div>
      <div class="form-grid form-grid--four">
        <label class="span-2">
          <span>胶片批次</span>
          <select v-model.number="form.filmId" data-testid="field-filmId">
            <option v-for="film in filmStore.films" :key="film.id" :value="film.id">
              {{ filmLabel(film.id ?? 0) }}
            </option>
          </select>
        </label>
        <label class="span-2">
          <span>显影液</span>
          <select v-model.number="form.developerId" data-testid="field-developerId">
            <option v-for="developer in developerStore.developers" :key="developer.id" :value="developer.id">
              {{ developerLabel(developer.id ?? 0) }}
            </option>
          </select>
        </label>
        <div class="span-2">
          <DilutionInput
            v-model:ratio="form.dilution"
            v-model:working-volume-ml="sampleWorkingVolume"
            ratio-test-id="field-dilution"
            volume-test-id="field-workingVolumeMl"
          />
        </div>
        <label>
          <span>显影温度</span>
          <input v-model.number="form.tempC" data-testid="field-tempC" type="number" min="15" max="45" step="0.5" />
        </label>
        <label>
          <span>显影时间</span>
          <input v-model.number="form.devMinutes" data-testid="field-devMinutes" type="number" min="0.5" max="60" step="0.25" />
        </label>
        <label>
          <span>摇罐方式</span>
          <input v-model="form.agitation" data-testid="field-agitation" type="text" />
        </label>
        <label>
          <span>停显</span>
          <input v-model="form.stopBath" data-testid="field-stopBath" type="text" />
        </label>
        <label class="span-2">
          <span>定影</span>
          <input v-model="form.fixer" data-testid="field-fixer" type="text" />
        </label>
        <label>
          <span>水洗分钟</span>
          <input v-model.number="form.washMinutes" data-testid="field-washMinutes" type="number" min="1" max="60" />
        </label>
        <label>
          <span>推拉档</span>
          <select v-model="form.pushPull" data-testid="field-pushPull">
            <option value="-1">拉档 -1</option>
            <option value="N">标准 N</option>
            <option value="+1">推档 +1</option>
            <option value="+2">推档 +2</option>
          </select>
        </label>
        <label class="span-4">
          <span>经验注释</span>
          <input v-model="form.note" data-testid="field-note" type="text" placeholder="记录新批次需要留意的曝光或密度特点" />
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="button" class="ghost-button" data-testid="save-recipe-draft" :disabled="saving || publishing" @click="saveDraft">
          {{ saving ? '保存中…' : '保存草稿' }}
        </button>
        <button type="submit" class="primary-button" data-testid="publish-recipe" :disabled="saving || publishing">
          {{ saving || publishing ? '发布中…' : '保存并发布' }}
        </button>
      </div>
    </form>

    <div v-if="recipeStore.draftRecipes.length" class="panel draft-panel">
      <div class="panel__head">
        <div>
          <h2>待发布草稿</h2>
          <p>草稿只作为下一版依据；发布前，已排期待冲仍读取当前已发布版本。</p>
        </div>
        <span class="status-chip status--amber">{{ recipeStore.draftRecipes.length }} 份草稿</span>
      </div>
      <div class="draft-grid">
        <article v-for="draft in recipeStore.draftRecipes" :key="draft.id" class="draft-card">
          <div class="entity-card__title">
            <div>
              <h2>配方组 #{{ draft.groupId }}</h2>
              <p>{{ filmLabel(draft.filmId) }} · {{ developerLabel(draft.developerId) }}</p>
            </div>
            <span class="status-chip status--amber">草稿</span>
          </div>
          <div class="data-pairs">
            <div><dt>基准</dt><dd>{{ draft.tempC }}°C / {{ draft.devMinutes.toFixed(2) }} 分钟</dd></div>
            <div><dt>稀释 / 档位</dt><dd>{{ draft.dilution }} · {{ draft.pushPull }}</dd></div>
          </div>
          <small v-if="draft.note">{{ draft.note }}</small>
          <div class="form-actions draft-card__actions">
            <button type="button" class="text-button text-button--danger" @click="discardDraft(draft)">放弃</button>
            <button type="button" class="ghost-button" @click="openEditor(draft)">继续编辑</button>
            <button
              type="button"
              class="primary-button"
              data-testid="publish-draft"
              :disabled="publishing"
              @click="draft.id !== undefined && publishExistingDraft(draft.id)"
            >
              {{ publishing && publishingId === draft.id ? '发布中…' : '发布新版' }}
            </button>
          </div>
        </article>
      </div>
    </div>

    <div class="panel recipe-toolbar">
      <div class="quick-filters">
        <label>
          <span>胶片</span>
          <select v-model="filmId">
            <option value="all">全部胶片</option>
            <option v-for="film in filmStore.films" :key="film.id" :value="film.id">{{ film.model }} · {{ film.emulsionNo }}</option>
          </select>
        </label>
        <label>
          <span>稀释比</span>
          <select v-model="dilution">
            <option value="all">全部稀释比</option>
            <option value="1:1">1:1</option>
            <option value="1:3">1:3</option>
          </select>
        </label>
        <label>
          <span>推拉档</span>
          <select v-model="pushPull">
            <option value="all">全部档位</option>
            <option value="-1">拉档 -1</option>
            <option value="N">标准 N</option>
            <option value="+1">推档 +1</option>
            <option value="+2">推档 +2</option>
          </select>
        </label>
        <label>
          <span>查看温度</span>
          <input v-model.number="actualTempC" type="number" min="15" max="45" step="0.5" />
        </label>
      </div>
      <button type="button" class="ghost-button" @click="resetFilters">重置筛选</button>
    </div>

    <div class="recipe-layout">
      <div class="panel">
        <div class="panel__head">
          <div>
            <h2>当前发布版本</h2>
            <p>当前筛选显示 {{ filteredRecipes.length }} 条最新版，共 {{ recipeStore.latestPublishedRecipes.length }} 个配方组；历史版本不会被覆盖。</p>
          </div>
          <span class="count-pill">配方组 <strong data-testid="count-recipe">{{ recipeStore.latestPublishedRecipes.length }}</strong></span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>胶片 / 显影液</th>
                <th>版本基准</th>
                <th>查看温度折算</th>
                <th>推拉档</th>
                <th>后处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="recipe in filteredRecipes" :key="recipe.id" data-testid="row-recipe">
                <td>
                  <strong>{{ filmLabel(recipe.filmId) }}</strong>
                  <small>{{ developerLabel(recipe.developerId) }} · {{ recipe.dilution }}</small>
                  <em v-if="recipe.note">{{ recipe.note }}</em>
                </td>
                <td>
                  <span class="status-chip status--cyan">v{{ recipe.version }} 已发布</span>
                  <small>{{ recipe.tempC }}°C / {{ recipe.devMinutes.toFixed(2) }} 分钟</small>
                </td>
                <td>
                  <strong class="accent-number">{{ suggestedFor(recipe).toFixed(2) }} 分钟</strong>
                  <small>{{ actualTempC }}°C 实测温度</small>
                </td>
                <td><PushPullTag :value="recipe.pushPull" show-hint /></td>
                <td>
                  <span>{{ recipe.agitation }}</span>
                  <small>{{ recipe.stopBath }} · {{ recipe.fixer }} · 水洗 {{ recipe.washMinutes }} 分钟</small>
                  <button type="button" class="text-button" data-testid="edit-recipe" @click="openEditor(recipe)">
                    {{ recipe.groupId !== undefined && recipeStore.getDraftByGroup(recipe.groupId) ? '打开草稿' : '修改草稿' }}
                  </button>
                  <button type="button" class="text-button" @click="deriveRecipe(recipe)">复制派生</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="filteredRecipes.length === 0" class="inline-empty">没有匹配配方，重置筛选或新建一份草稿并发布。</div>
        </div>
      </div>

      <aside>
        <TimeTempCurve
          :points="curvePoints"
          :selected-temp="actualTempC"
          title="时间补偿曲线"
          @pick-temp="pickCurveTemp"
        />
        <div class="panel formula-note">
          <h2>版本规则</h2>
          <p>编辑先进入草稿。发布后，等待中实冲改用新版本；刚进罐和已完成罐次继续读取各自当时的旧版。</p>
          <p>胶片批次或显影液变化时，等待中的实冲会重新要求确认，未确认不能开冲。</p>
          <strong>{{ actualTempC }}°C · 当前建议 {{ suggest(filteredRecipes[0]?.devMinutes ?? 0, actualTempC).minutes.toFixed(2) }} 分钟</strong>
        </div>
        <div class="panel version-panel">
          <div class="panel__head">
            <div>
              <h2>已发布版本</h2>
              <p>历史罐次按这里的具体版本追溯。</p>
            </div>
          </div>
          <div class="version-list">
            <div v-for="recipe in versionHistory" :key="recipe.id" class="version-item">
              <strong>#{{ recipe.groupId }} · v{{ recipe.version }}</strong>
              <small>{{ filmLabel(recipe.filmId) }} · {{ recipe.tempC }}°C / {{ recipe.devMinutes.toFixed(2) }} 分钟</small>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.draft-panel {
  border-color: rgba(169, 95, 47, 0.32);
  background: linear-gradient(150deg, #fffaf2, #fbf0e2);
}

.draft-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}

.draft-card {
  display: grid;
  gap: 12px;
  padding: 15px;
  border: 1px solid #e4c9aa;
  border-radius: 14px;
  background: #fffdf8;
}

.draft-card p,
.draft-card small {
  color: var(--ink-soft);
  font-size: 11px;
}

.draft-card__actions {
  justify-content: flex-end;
}

.version-panel {
  max-height: 330px;
  overflow: auto;
}

.version-list {
  display: grid;
  gap: 8px;
}

.version-item {
  display: grid;
  gap: 3px;
  padding: 9px 10px;
  border-left: 3px solid #8ab5b3;
  border-radius: 8px;
  background: #f4f9f7;
}

.version-item strong {
  font-size: 12px;
}

.version-item small {
  color: var(--ink-soft);
  font-size: 10px;
}
</style>
