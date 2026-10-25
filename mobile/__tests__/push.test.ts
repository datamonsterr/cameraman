import { targetFromData } from '@/lib/push'

jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }))
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }))
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)
jest.mock('expo-secure-store', () => ({}))

describe('targetFromData', () => {
  it('routes camera alerts to the camera view', () => {
    expect(targetFromData({ camera_id: 'c1', event_id: 5 })).toEqual({
      pathname: '/camera/[id]',
      params: { id: 'c1' },
    })
  })
  it('falls back to the events feed', () => {
    expect(targetFromData({ event_id: 5 })).toEqual({ pathname: '/events' })
  })
  it('ignores junk', () => {
    expect(targetFromData(null)).toBeNull()
    expect(targetFromData({})).toBeNull()
  })
})
