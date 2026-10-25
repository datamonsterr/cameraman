import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { StateStorage } from 'zustand/middleware'

// SecureStore keys: alphanumerics, ".", "-", "_" only. Values are limited in size on some
// platforms, so fall back to AsyncStorage when SecureStore is unavailable (e.g. web) or throws.
let secureOk: boolean | null = null

async function secureAvailable(): Promise<boolean> {
  if (secureOk === null) {
    try {
      secureOk = await SecureStore.isAvailableAsync()
    } catch {
      secureOk = false
    }
  }
  return secureOk
}

export const secureStorage: StateStorage = {
  async getItem(name) {
    if (await secureAvailable()) {
      try {
        return await SecureStore.getItemAsync(name)
      } catch {
        /* fall through */
      }
    }
    return AsyncStorage.getItem(name)
  },
  async setItem(name, value) {
    if (await secureAvailable()) {
      try {
        await SecureStore.setItemAsync(name, value)
        return
      } catch {
        /* fall through */
      }
    }
    await AsyncStorage.setItem(name, value)
  },
  async removeItem(name) {
    if (await secureAvailable()) {
      try {
        await SecureStore.deleteItemAsync(name)
      } catch {
        /* ignore */
      }
    }
    await AsyncStorage.removeItem(name)
  },
}
