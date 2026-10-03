<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import DilutionInput from '../components/common/DilutionInput.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import TimeTempCurve from '../components/common/TimeTempCurve.vue'
import { calculateCompensatedMinutes, useTempCompensate } from '../hooks/useTempCompensate'
import { useRecipeFilter } from '../hooks/useRecipeFilter'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useRecipeStore, type RecipeDraftInput } from '../stores/recipeStore'
import { diffMaterial } from '../utils/recipeVersioning'
import type { Developer, Dilution } from '../types/developer'
import type { DevRecipe, PushPull } from '../types/dev-recipe'

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
const editingRecipeId = ref<number | null>(null)
const editingDraftId = ref<number | undefined>(undefined)
const historyRecipeId = ref<number | null>(null)
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

const formTitle = computed(() => editingRecipeId.value === null ? '编排新配方（先存草稿）' : '编辑配方新版本（草稿）')

const historyVersions = computed(() => {
  if (historyRecipeId.value === null) return []
  return recipeStore.versionsByRecipeId(historyRecipeId.value)
})

/** 还没有任何已发布版本的草稿（全新配方） */
const orphanDrafts = computed(() => recipeStore.draftRecipes.filter(
  (draft) => !recipeStore.currentRecipes.some((recipe) => recipe.recipeId === draft.recipeId)
))

function openDraftOnly(draft: DevRecipe): void {
  editingRecipeId.value = draft.recipeId
  editingDraftId.value = draft.id
  toForm(draft)
  showForm.value = true
}

function draftOf(recipeId: number): DevRecipe | undefined {
  return recipeStore.draftByRecipeId(recipeId)
}

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

function toForm(recipe: DevRecipe): void {
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

function openCreate(): void {
  editingRecipeId.value = null
  editingDraftId.value = undefined
  toForm({    filmId: filmStore.films[0]?.id ?? 1,
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
  } as DevRecipe)
  showForm.value = true
}

function openEdit(recipe: DevRecipe): void {
  editingRecipeId.value = recipe.recipeId
  const draft = draftOf(recipe.recipeId)
  editingDraftId.value = draft?.id
  toForm(draft ?? recipe)
  showForm.value = true
}

function openHistory(recipe: DevRecipe): void {
  historyRecipeId.value = recipe.recipeId
}

function materialHints(draft: DevRecipe): string[] {
  const current = recipeStore.currentRecipes.find((item) => item.recipeId === draft.recipeId)
  const change = diffMaterial(draft, current)
  const hints: string[] = []
  if (change.filmChanged) {
    hints.push(`胶片批次将由「${current ? filmLabel(current.filmId) : '—'}」改为「${filmLabel(draft.filmId)}」`)
  }
  if (change.developerChanged) {
    hints.push(`显影液将由「${current ? developerLabel(current.developerId) : '—'}」改为「${developerLabel(draft.developerId)}」`)
  }
  return hints
}

function formPayload(): RecipeDraftInput {
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

async function submitDraft(): Promise<void> {
  if (!form.filmId || !form.developerId || !form.devMinutes) {
    ElMessage.warning('请选择胶片、显影液并填写显影时间')
    return
  }
  saving.value = true
  try {
    if (editingRecipeId.value === null) {
      const created = await recipeStore.createDraft(formPayload())
      editingDraftId.value = created.id
      editingRecipeId.value = created.recipeId
      ElMessage.success('草稿已保存，发布后才会成为 v1 并可排入冲洗')
    } else {
      editingDraftId.value = await recipeStore.saveDraft(
        editingRecipeId.value,
        formPayload(),
        editingDraftId.value
      )
      ElMessage.success('草稿已保存，当前发布版本与在冲罐次不受影响')
    }
  } finally {
    saving.value = false
  }
}

async function publishDraftRow(draft: DevRecipe): Promise<void> {
  if (draft.id === undefined) return
  const current = recipeStore.currentRecipes.find((item) => item.recipeId === draft.recipeId)
  const hints = materialHints(draft)
  const nextVersion = (current?.version ?? 0) + 1
  const confirmText = [
    current
      ? `发布后将生成 v${nextVersion}：`
      : '发布后该配方将首次生效（v1）：',
    current ? '· 等待开冲的实冲改用新版本并需重新核对' : '· 发布后才能排入冲洗排期',
    '· 进行中与已完成罐次继续读取旧版',
    hints.length ? `· ${hints.join('；')}，等待中的实冲需重新确认才能开冲` : '· 仅参数变化，等待中已确认的实冲仍有效'
  ].join('\n')
  try {
    await ElMessageBox.confirm(confirmText, current ? '发布配方新版本' : '发布新配方', {
      confirmButtonText: '发布',
      cancelButtonText: '再看看',
      type: 'warning'
    })
  } catch {
    return
  }
  publishing.value = true
  try {
    const result = await recipeStore.publishDraft(draft.id)
    if (editingRecipeId.value === draft.recipeId) {
      editingRecipeId.value = null
      editingDraftId.value = undefined
      showForm.value = false
    }
    if (result.retried) {
      ElMessage.success(`已是 v${result.version}（重试未重复生成版本）`)
    } else if (result.reconfirmedRunIds.length > 0) {
      ElMessage.warning(`已发布 v${result.version}，${result.reconfirmedRunIds.length} 条等待中的实冲需重新确认后才能开冲`)
    } else {
      ElMessage.success(`已发布 v${result.version}，等待中的实冲已改用新版本`)
    }
  } catch (error) {
    ElMessage.error(`发布失败，草稿与确认结果已保留，可直接重试：${(error as Error).message}`)
  } finally {
    publishing.value = false
  }
}

async function discardDraftRow(draft: DevRecipe): Promise<void> {
  if (draft.id === undefined) return
  try {
    await ElMessageBox.confirm('放弃后草稿内容会被删除，已发布版本不受影响。', '丢弃草稿', {
      confirmButtonText: '丢弃',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  await recipeStore.discardDraft(draft.id)
  if (editingRecipeId.value === draft.recipeId) {
    editingRecipeId.value = null
    editingDraftId.value = undefined
    showForm.value = false
  }
  ElMessage.success('草稿已丢弃')
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load()])
  if (filmStore.films[0]?.id !== undefined) form.filmId = filmStore.films[0].id
  const usableDeveloper = developerStore.developers.find((item: Developer) => item.state !== '报废')
  if (usableDeveloper?.id !== undefined) form.developerId = usableDeveloper.id
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">PROCESS RECIPES</span>
        <h1>配方表</h1>
        <p>编辑先存草稿，发布后等待开冲的实冲才改用新版本；进行中与已完成罐次继续读旧版。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-recipe" @click="openCreate">
        新建配方
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-recipe" @submit.prevent="submitDraft">
      <div class="inline-form__head">
        <div>
          <h2>{{ formTitle }}</h2>
          <p>草稿保存后不影响任何罐次；确认无误再发布。</p>
        </div>
      </div>
      <div class="form-grid form-grid--four">
        <label class="span-2">
          <span>胶片</span>
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
        <button type="submit" class="ghost-button" data-testid="save-draft" :disabled="saving">
          {{ saving ? '保存中…' : '保存草稿' }}
        </button>
        <button
          v-if="editingDraftId !== undefined"
          type="button"
          class="primary-button"
          data-testid="publish-draft"
          :disabled="publishing"
          @click="() => {
            const draft = recipeStore.recipes.find((item) => item.id === editingDraftId && item.status === 'draft')
            if (draft) publishDraftRow(draft)
          }"
        >
          {{ publishing ? '发布中…' : '发布新版本' }}
        </button>
      </div>
    </form>

    <div v-if="orphanDrafts.length" class="panel orphan-drafts" data-testid="orphan-drafts">
      <div class="panel__head">
        <div>
          <h2>待发布的新配方</h2>
          <p>以下配方还没有任何已发布版本，不能排入冲洗；发布后成为 v1。</p>
        </div>
      </div>
      <ul class="version-list">
        <li v-for="draft in orphanDrafts" :key="draft.id">
          <strong>未发布草稿 · 配方组 #{{ draft.recipeId }}</strong>
          <span>{{ filmLabel(draft.filmId) }} · {{ developerLabel(draft.developerId) }} · {{ draft.dilution }} · {{ draft.pushPull }}</span>
          <small>{{ draft.tempC }}°C / {{ draft.devMinutes.toFixed(2) }} 分钟 · {{ draft.agitation }}</small>
          <span class="row-actions">
            <button type="button" class="text-button" @click="openDraftOnly(draft)">编辑</button>
            <button type="button" class="text-button" @click="discardDraftRow(draft)">丢弃</button>
            <button type="button" class="primary-button" :disabled="publishing" @click="publishDraftRow(draft)">发布为 v1</button>
          </span>
        </li>
      </ul>
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
            <h2>配方清单（当前发布版）</h2>
            <p>当前筛选显示 {{ filteredRecipes.length }} 条，共 {{ recipeStore.currentRecipes.length }} 个配方，草稿 {{ recipeStore.draftRecipes.length }} 条。</p>
          </div>
          <span class="count-pill">配方数 <strong data-testid="count-recipe">{{ recipeStore.currentRecipes.length }}</strong></span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>胶片 / 显影液</th>
                <th>版本 / 基准</th>
                <th>查看温度折算</th>
                <th>推拉档</th>
                <th>后处理 / 操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="recipe in filteredRecipes" :key="recipe.recipeId">
                <tr data-testid="row-recipe">
                  <td>
                    <strong>{{ filmLabel(recipe.filmId) }}</strong>
                    <small>{{ developerLabel(recipe.developerId) }} · {{ recipe.dilution }}</small>
                    <em v-if="recipe.note">{{ recipe.note }}</em>
                  </td>
                  <td>
                    <strong class="accent-number">v{{ recipe.version }}</strong>
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
                    <span class="row-actions">
                      <button type="button" class="text-button" data-testid="edit-recipe" @click="openEdit(recipe)">
                        {{ draftOf(recipe.recipeId) ? '编辑草稿' : '改新版' }}
                      </button>
                      <button type="button" class="text-button" data-testid="history-recipe" @click="openHistory(recipe)">版本历史</button>
                    </span>
                  </td>
                </tr>
                <tr v-if="draftOf(recipe.recipeId)" class="draft-row" data-testid="row-draft">
                  <td colspan="5">
                    <div class="draft-banner">
                      <div>
                        <strong>草稿待发布（v{{ (recipe.version ?? 1) + 1 }}）</strong>
                        <ul v-if="materialHints(draftOf(recipe.recipeId)!).length" class="draft-hints">
                          <li v-for="hint in materialHints(draftOf(recipe.recipeId)!)" :key="hint">{{ hint }}，发布后等待中的实冲须重新确认</li>
                        </ul>
                        <small v-else>仅参数调整：发布后等待中实冲换版，既有确认保留；进行中与历史罐次不受影响。</small>
                      </div>
                      <span class="row-actions">
                        <button type="button" class="text-button" @click="openEdit(recipe)">继续编辑</button>
                        <button type="button" class="text-button" data-testid="discard-draft" @click="discardDraftRow(draftOf(recipe.recipeId)!)">丢弃</button>
                        <button type="button" class="primary-button" data-testid="publish-row" :disabled="publishing" @click="publishDraftRow(draftOf(recipe.recipeId)!)">
                          发布
                        </button>
                      </span>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-if="filteredRecipes.length === 0" class="inline-empty">没有匹配配方，重置筛选或新建一条。</div>
        </div>
      </div>

      <aside>
        <TimeTempCurve
          :points="curvePoints"
          :selected-temp="actualTempC"
          title="时间补偿曲线（当前版）"
          @pick-temp="pickCurveTemp"
        />
        <div class="panel formula-note">
          <h2>版本与发布</h2>
          <p>草稿不影响任何罐次；发布后等待开冲的实冲换用新版本，进行中与已完成罐次继续读取发布时的旧版。胶片批次或显影液变化时，等待中的实冲需重新确认才能开冲。</p>
          <strong>{{ actualTempC }}°C · 建议 {{ suggest(filteredRecipes[0]?.devMinutes ?? 0, actualTempC).minutes.toFixed(2) }} 分钟</strong>
        </div>
        <div v-if="historyVersions.length" class="panel">
          <div class="panel__head">
            <div>
              <h2>版本历史</h2>
              <p>历史罐次按下表版本号追溯当时依据。</p>
            </div>
            <button type="button" class="text-button" @click="historyRecipeId = null">关闭</button>
          </div>
          <ul class="version-list" data-testid="version-history">
            <li v-for="version in historyVersions" :key="version.id">
              <strong>v{{ version.version }}</strong>
              <small>{{ version.publishedAt ? new Date(version.publishedAt).toLocaleString() : '初版迁移' }}</small>
              <span>{{ filmLabel(version.filmId) }} · {{ developerLabel(version.developerId) }}</span>
              <small>{{ version.tempC }}°C / {{ version.devMinutes.toFixed(2) }} 分钟 · {{ version.agitation }}</small>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </section>
</template>
