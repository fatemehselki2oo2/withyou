import type { ActivityReading, BaselineProfile, PatternAnalysis, SensorReading } from './types'

const DB_NAME = 'withyou-local'
const DB_VERSION = 2
const LEGACY_READING_STORE = 'activityReadings'
const SENSOR_STORE = 'sensorReadings'
const BASELINE_STORE = 'baselineProfiles'
const PATTERN_STORE = 'patternEvents'

export const DEMO_BASELINE: BaselineProfile = {
  id: 'demo',
  normal_activity_level: 0.65,
  normal_inactivity_duration: 120,
  normal_sleep_duration: 7.5,
  normal_wake_time: '08:30',
  normal_sound_level: 0.42,
  baseline_status: 'ready',
  baseline_confidence: 'high',
  is_demo_baseline: true,
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(LEGACY_READING_STORE)) {
        const legacy = database.createObjectStore(LEGACY_READING_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        })
        legacy.createIndex('timestamp', 'timestamp')
      }
      if (!database.objectStoreNames.contains(SENSOR_STORE)) {
        const readings = database.createObjectStore(SENSOR_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        })
        readings.createIndex('timestamp', 'timestamp')
        readings.createIndex('sensor_type', 'sensor_type')
        readings.createIndex('source', 'source')
      }
      if (!database.objectStoreNames.contains(BASELINE_STORE)) {
        database.createObjectStore(BASELINE_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(PATTERN_STORE)) {
        const patterns = database.createObjectStore(PATTERN_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        })
        patterns.createIndex('timestamp', 'timestamp')
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function initializeDatabase(): Promise<BaselineProfile> {
  const database = await openDatabase()
  const transaction = database.transaction(BASELINE_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(BASELINE_STORE)
  const existing = await requestResult(store.get('demo')) as Partial<BaselineProfile> | undefined
  const baseline = { ...DEMO_BASELINE, ...existing }
  store.put(baseline)
  await done
  database.close()
  return baseline
}

export async function saveSensorReading(reading: SensorReading): Promise<SensorReading> {
  const database = await openDatabase()
  const transaction = database.transaction(SENSOR_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const id = await requestResult(transaction.objectStore(SENSOR_STORE).add(reading)) as number
  await done
  database.close()
  return { ...reading, id }
}

export async function getTodaySensorReadings(): Promise<SensorReading[]> {
  const database = await openDatabase()
  const transaction = database.transaction(SENSOR_STORE, 'readonly')
  const done = transactionDone(transaction)
  const readings = await requestResult(transaction.objectStore(SENSOR_STORE).getAll()) as SensorReading[]
  await done
  database.close()

  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return readings.filter((reading) => new Date(reading.timestamp).getTime() >= start.getTime())
}

export async function savePatternEvent(pattern: PatternAnalysis): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(PATTERN_STORE, 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(PATTERN_STORE).add({ timestamp: new Date().toISOString(), ...pattern })
  await done
  database.close()
}

export async function clearLocalData(): Promise<BaselineProfile> {
  const database = await openDatabase()
  const stores = [LEGACY_READING_STORE, SENSOR_STORE, BASELINE_STORE, PATTERN_STORE]
  const transaction = database.transaction(stores, 'readwrite')
  const done = transactionDone(transaction)
  stores.forEach((store) => transaction.objectStore(store).clear())
  transaction.objectStore(BASELINE_STORE).put(DEMO_BASELINE)
  await done
  database.close()
  return DEMO_BASELINE
}

// Milestone 1 compatibility helpers remain available for existing callers.
export async function saveReading(reading: ActivityReading): Promise<ActivityReading> {
  const database = await openDatabase()
  const transaction = database.transaction(LEGACY_READING_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const id = await requestResult(transaction.objectStore(LEGACY_READING_STORE).add(reading)) as number
  await done
  database.close()
  return { ...reading, id }
}

export async function getTodayReadings(): Promise<ActivityReading[]> {
  const database = await openDatabase()
  const transaction = database.transaction(LEGACY_READING_STORE, 'readonly')
  const done = transactionDone(transaction)
  const readings = await requestResult(transaction.objectStore(LEGACY_READING_STORE).getAll()) as ActivityReading[]
  await done
  database.close()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return readings.filter((reading) => new Date(reading.timestamp).getTime() >= start.getTime())
}
