<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PetApp from './pet/PetApp.vue'
import SettingsApp from './settings/SettingsApp.vue'
import ChatApp from './chat/ChatApp.vue'
import { getLabel } from './lib/tauri'

const label = ref('pet')
onMounted(() => (label.value = getLabel()))
const view = computed(() => {
  if (label.value === 'settings') return SettingsApp
  if (label.value === 'chat') return ChatApp
  return PetApp
})
</script>

<template>
  <component :is="view" />
</template>
