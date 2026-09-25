import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"

import AsyncStorage from "@react-native-async-storage/async-storage"

import * as Crypto from "expo-crypto"

import * as DocumentPicker from "expo-document-picker"

import * as FileSystem from "expo-file-system/legacy"

import { useSQLiteContext } from "expo-sqlite"

import { drizzle } from "drizzle-orm/expo-sqlite"

import { eq } from "drizzle-orm"

import * as schema from "../db/schema"

import {
  createDatabaseSyncPayload,
  applyChanges,
  setLastSyncAt,
  getChangesCount,
} from "../utils/databaseSync"

import AvocatoFlow from "../modules/avocato-flow/src"

import { MaterialIcons } from "@react-native-vector-icons/material-icons"

// ============================================================
// USB / ADB REVERSE
// ============================================================

const USB_HOST = "127.0.0.1"

const USB_WS_PORT = 47822

const USB_HTTP_PORT = 47823

// ============================================================
// STORAGE
// ============================================================

const DEVICE_ID_KEY = "@avocato_flow_device_id"

const TRUSTED_USB_KEY = "@avocato_flow_trusted_usb"

// ============================================================
// HELPERS
// ============================================================

function createDeviceId() {
  const random = Math.random().toString(16).slice(2)

  return `android-${Date.now().toString(16)}-${random}`
}

function createRequestId() {
  if (typeof Crypto.randomUUID === "function") {
    return Crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createUsbPcDevice(data = {}) {
  return {
    id: data.id || "usb-pc",

    name: data.name || "Avocato Desktop",

    platform: data.platform || "windows",

    transport: "usb",

    ip: USB_HOST,

    websocketPort: USB_WS_PORT,

    httpPort: USB_HTTP_PORT,

    trusted: data.trusted === true,
  }
}

function parseIncomingMessage(incoming) {
  if (incoming === null || incoming === undefined) {
    return null
  }

  let raw = incoming?.message ?? incoming

  if (raw === null || raw === undefined) {
    return null
  }

  if (typeof raw === "object") {
    return raw
  }

  if (typeof raw !== "string") {
    return null
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    console.log("USB JSON PARSE ERROR:", error)

    return null
  }
}

function sanitizePathPart(value, fallback = "file") {
  if (!value) {
    return fallback
  }

  return (
    String(value)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\.\./g, "_")
      .trim() || fallback
  )
}

function normalizeRelativePath(value) {
  if (!value) {
    return null
  }

  const normalized = String(value)
    .replace(/\\/g, "/")
    .split("/")
    .map(part => sanitizePathPart(part, "file"))
    .filter(Boolean)
    .join("/")

  return normalized || null
}

async function getFileInfoSafe(uri, timeout = 1500) {
  try {
    const timeoutPromise = new Promise(resolve => {
      setTimeout(() => resolve(null), timeout)
    })

    return await Promise.race([FileSystem.getInfoAsync(uri), timeoutPromise])
  } catch (error) {
    console.warn("USB FILE INFO ERROR:", error)

    return null
  }
}

// ============================================================
// SCREEN
// ============================================================

export default function UsbSyncScreen() {
  const database = useSQLiteContext()

  const db = useMemo(
    () =>
      drizzle(database, {
        schema,
      }),
    [database],
  )

  // ==========================================================
  // CONNECTION
  // ==========================================================

  const [usbConnected, setUsbConnected] = useState(false)

  const [usbStatus, setUsbStatus] = useState("disconnected")

  const [usbError, setUsbError] = useState("")

  // ==========================================================
  // DEVICE
  // ==========================================================

  const [deviceId, setDeviceId] = useState("")

  const [deviceName, setDeviceName] = useState("Android")

  const [pcDevice, setPcDevice] = useState(null)

  // ==========================================================
  // PAIRING
  // ==========================================================

  const [trusted, setTrusted] = useState(false)

  const [pairingState, setPairingState] = useState("none")

  const [pairingRequestId, setPairingRequestId] = useState("")

  const [pairingCode, setPairingCode] = useState("")

  // ==========================================================
  // DATABASE
  // ==========================================================

  const [databaseSyncing, setDatabaseSyncing] = useState(false)

  const [databaseProgress, setDatabaseProgress] = useState(0)

  const [databaseSyncSuccess, setDatabaseSyncSuccess] = useState(false)
  const [caseFilesSyncSuccess,setCaseFilesSyncSuccess] = useState(false)
  

  // ==========================================================
  // FILES
  // ==========================================================

  const [transfers, setTransfers] = useState([])

  const [fileSyncing, setFileSyncing] = useState(false)

  // ==========================================================
  // DEBUG
  // ==========================================================

  const [lastMessage, setLastMessage] = useState(null)

  const [messageCount, setMessageCount] = useState(0)

  // ==========================================================
  // REFS
  // ==========================================================

  const mountedRef = useRef(true)

  const connectedRef = useRef(false)

  const trustedRef = useRef(false)

  const deviceIdRef = useRef("")

  const pcDeviceRef = useRef(null)

  const connectingRef = useRef(false)
  const connectionOfflineRef = useRef(false)

  const databaseSyncRunningRef = useRef(false)

  const databaseSyncRequestRef = useRef(null)

  const pendingFilesRef = useRef(new Map())

  const incomingDownloadsRef = useRef(new Map())

  const notifiedTransfersRef = useRef(new Set())

  const completedFilesRef = useRef(new Set())

  // ==========================================================
  // FILE AUTO SYNC REFS
  // ==========================================================

  const autoSyncStartedRef = useRef(false)

  const autoSyncFilesRef = useRef(new Set())

  const autoSyncQueueRef = useRef([])

  const autoSyncCurrentRef = useRef(null)

  const autoSyncWaitersRef = useRef(new Map())

  const syncDatabaseFilesRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const manualDisconnectRef = useRef(false)
  const reconnectAttemptRef = useRef(0)
  const caseFilesSyncRunningRef = useRef(false)

  const caseFilesSyncRequestRef = useRef(null)

  const caseFilesSyncGenerationRef = useRef(0)

  const caseFilesPendingUploadsRef = useRef(new Map())

  const caseFilesCompletedUploadsRef = useRef(new Set())

  // ==========================================================
  // LOAD DEVICE ID
  // ==========================================================

  const loadDeviceId = useCallback(async () => {
    try {
      let id = await AsyncStorage.getItem(DEVICE_ID_KEY)

      if (!id) {
        id = createDeviceId()

        await AsyncStorage.setItem(DEVICE_ID_KEY, id)
      }

      deviceIdRef.current = id

      setDeviceId(id)

      return id
    } catch (error) {
      console.log("USB DEVICE ID ERROR:", error)

      const fallback = createDeviceId()

      deviceIdRef.current = fallback

      setDeviceId(fallback)

      return fallback
    }
  }, [])

  // ==========================================================
  // LOAD TRUSTED
  // ==========================================================

  const loadTrustedUsb = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(TRUSTED_USB_KEY)

      if (!raw) {
        return null
      }

      return JSON.parse(raw)
    } catch (error) {
      console.log("LOAD TRUSTED USB ERROR:", error)

      return null
    }
  }, [])

  // ==========================================================
  // SAVE TRUSTED
  // ==========================================================

  const saveTrustedUsb = useCallback(async device => {
    if (!device?.id) {
      return
    }

    const normalized = createUsbPcDevice({
      ...device,

      trusted: true,
    })

    pcDeviceRef.current = normalized

    setPcDevice(normalized)

    try {
      await AsyncStorage.setItem(TRUSTED_USB_KEY, JSON.stringify(normalized))
    } catch (error) {
      console.log("SAVE TRUSTED USB ERROR:", error)
    }
  }, [])

  // ==========================================================
  // SEND
  // ==========================================================

  const send = useCallback(message => {
    try {
      console.log("USB SEND:", message)

      const result = AvocatoFlow.sendMessage(JSON.stringify(message))

      console.log("USB SEND RESULT:", result)

      return result !== false
    } catch (error) {
      console.log("USB SEND ERROR:", error)

      setUsbError(error?.message || "فشل إرسال الرسالة.")

      return false
    }
  }, [])

  // ==========================================================
  // TRANSFER UPDATE
  // ==========================================================

  const updateTransfer = useCallback((requestId, patch) => {
    if (!requestId) {
      return
    }

    setTransfers(previous =>
      previous.map(item =>
        item.requestId === requestId
          ? {
              ...item,
              ...patch,
            }
          : item,
      ),
    )
  }, [])

  // ==========================================================
  // FIND REQUEST BY TRANSFER
  // ==========================================================

  const findRequestIdByTransferId = useCallback(transferId => {
    if (!transferId) {
      return null
    }

    for (const [requestId, file] of pendingFilesRef.current) {
      if (file?.transferId === transferId) {
        return requestId
      }
    }

    return null
  }, [])

  // ==========================================================
  // RESOLVE REQUEST ID
  // ==========================================================

  const resolveRequestId = useCallback(
    (message, payload = {}) => {
      const directRequestId = message?.requestId || payload?.requestId

      if (directRequestId) {
        return directRequestId
      }

      const transferId = message?.transferId || payload?.transferId

      if (!transferId) {
        return null
      }

      return findRequestIdByTransferId(transferId)
    },
    [findRequestIdByTransferId],
  )

  // ==========================================================
  // AUTO SYNC WAITER
  // ==========================================================

  const resolveAutoSyncWaiter = useCallback((requestId, success, error) => {
    if (!requestId) {
      return
    }

    const waiter = autoSyncWaitersRef.current.get(requestId)

    if (!waiter) {
      return
    }

    autoSyncWaitersRef.current.delete(requestId)

    if (success) {
      waiter.resolve()
    } else {
      waiter.reject(new Error(error || "FILE_TRANSFER_FAILED"))
    }
  }, [])

  // ==========================================================
  // TRANSFER ERROR
  // ==========================================================

  const markTransferError = useCallback(
    (requestId, errorMessage) => {
      if (requestId) {
        updateTransfer(requestId, {
          status: "error",
        })

        pendingFilesRef.current.delete(requestId)
      }

      if (requestId && autoSyncCurrentRef.current === requestId) {
        autoSyncCurrentRef.current = null
      }

      resolveAutoSyncWaiter(requestId, false, errorMessage)

      if (
        errorMessage &&
        requestId &&
        !notifiedTransfersRef.current.has(`error:${requestId}`)
      ) {
        notifiedTransfersRef.current.add(`error:${requestId}`)

        Alert.alert("خطأ في نقل الملف", errorMessage)
      }
    },
    [updateTransfer, resolveAutoSyncWaiter],
  )

  // ==========================================================
  // VERIFY DATABASE ROWS
  //
  // هذه الدالة لا تغير قاعدة البيانات.
  //
  // وظيفتها فقط التأكد من أن البيانات القادمة من Windows
  // أصبحت موجودة فعليًا في Android.
  // ==========================================================

  const verifyAppliedDatabaseChanges = useCallback(
    async changes => {
      const tables = [
        {
          name: "clients",

          table: schema.clients,
        },

        {
          name: "cases",

          table: schema.cases,
        },

        {
          name: "caseSessions",

          table: schema.caseSessions,
        },

        {
          name: "tasks",

          table: schema.tasks,
        },

        {
          name: "expenses",

          table: schema.expenses,
        },

        {
          name: "notes",

          table: schema.notes,
        },
      ]

      const verification = {}

      for (const item of tables) {
        const rows = Array.isArray(changes?.[item.name])
          ? changes[item.name]
          : []

        if (rows.length === 0) {
          verification[item.name] = {
            incoming: 0,

            found: 0,

            missing: 0,
          }

          continue
        }

        let found = 0

        let missing = 0

        for (const incoming of rows) {
          if (!incoming?.id) {
            continue
          }

          const local = await db
            .select()
            .from(item.table)
            .where(eq(item.table.id, incoming.id))
            .limit(1)

          if (local.length > 0) {
            found++
          } else {
            missing++
          }
        }

        verification[item.name] = {
          incoming: rows.length,

          found,

          missing,
        }
      }

      console.log("USB DATABASE VERIFICATION:", verification)

      return verification
    },
    [db],
  )

  // ==========================================================
  // DATABASE SYNC
  // ==========================================================

  const startDatabaseSync = useCallback(async () => {
    if (!connectedRef.current) {
      console.log("USB DATABASE SYNC: NOT CONNECTED")

      return
    }

    if (!trustedRef.current) {
      console.log("USB DATABASE SYNC: NOT TRUSTED")

      return
    }

    if (databaseSyncRunningRef.current) {
      console.log("USB DATABASE SYNC: ALREADY RUNNING")

      return
    }

    const peerId = pcDeviceRef.current?.id

    if (!peerId) {
      console.log("USB DATABASE SYNC: PC ID MISSING")

      return
    }

    try {
      databaseSyncRunningRef.current = true

      setDatabaseSyncing(true)

      setDatabaseProgress(10)

      const syncTime = new Date().toISOString()

      const payload = await createDatabaseSyncPayload(db, peerId, syncTime)

      const requestId = createRequestId()

      databaseSyncRequestRef.current = {
        requestId,

        peerId,

        syncTime,

        lastSyncAt: payload?.lastSyncAt || null,
      }

      const changesCount = getChangesCount(payload?.changes || {})

      console.log("========================================")

      console.log("USB DATABASE SYNC START")

      console.log({
        requestId,

        peerId,

        syncTime,

        lastSyncAt: payload?.lastSyncAt,

        changes: changesCount,
      })

      console.log("========================================")

      setDatabaseProgress(20)

      const message = {
        type: "DATABASE_SYNC_REQUEST",

        version: 1,

        requestId,

        timestamp: Date.now(),

        payload: {
          ...payload,

          requestId,

          deviceId: peerId,

          syncTime,

          transport: "usb",
        },
      }

      console.log(
        "USB DATABASE SYNC REQUEST:",
        JSON.stringify(message, null, 2),
      )

      const success = send(message)

      if (!success) {
        throw new Error("DATABASE_SYNC_REQUEST_SEND_FAILED")
      }
    } catch (error) {
      console.log("USB DATABASE SYNC START ERROR:", error)

      databaseSyncRequestRef.current = null

      databaseSyncRunningRef.current = false

      setDatabaseSyncing(false)

      setUsbError(error?.message || "فشل بدء مزامنة قاعدة البيانات.")
    }
  }, [db, send])

  // ==========================================================
  // DATABASE MESSAGE
  // ==========================================================

  const handleDatabaseSyncData = useCallback(
    async message => {
      try {
        const payload = message?.payload || {}

        const changes = payload?.changes || {}

        const syncTime =
          payload?.syncTime || databaseSyncRequestRef.current?.syncTime || null

        const baseSyncAt =
          payload?.baseSyncAt ||
          databaseSyncRequestRef.current?.lastSyncAt ||
          null

        if (!syncTime) {
          throw new Error("SYNC_TIME_MISSING")
        }

        console.log("========================================")

        console.log("USB DATABASE_SYNC_DATA RECEIVED")

        console.log({
          requestId: message?.requestId,

          syncTime,

          baseSyncAt,

          changes: getChangesCount(changes),
        })

        console.log("========================================")

        setDatabaseProgress(40)

        const applyResult = await applyChanges(db, changes)

        console.log("========================================")

        console.log("USB WINDOWS -> ANDROID APPLY RESULT")

        console.log(JSON.stringify(applyResult, null, 2))

        console.log("========================================")

        if (applyResult?.errors?.length) {
          throw new Error(`DATABASE_APPLY_ERRORS: ${applyResult.errors.length}`)
        }

        setDatabaseProgress(70)

        const verification = await verifyAppliedDatabaseChanges(changes)

        const missing = Object.values(verification).reduce(
          (total, item) => total + Number(item?.missing || 0),
          0,
        )

        console.log("USB DATABASE MISSING ROWS:", missing)

        if (missing > 0) {
          console.warn(
            "USB DATABASE WARNING: بعض السجلات غير موجودة بعد التطبيق",
          )
        }

        setDatabaseProgress(85)

        const success = send({
          type: "DATABASE_SYNC_APPLIED",

          version: 1,

          requestId:
            message?.requestId ||
            databaseSyncRequestRef.current?.requestId ||
            null,

          timestamp: Date.now(),

          payload: {
            success: true,

            syncTime,

            baseSyncAt,

            deviceId: deviceIdRef.current,

            transport: "usb",

            applyResult,
          },
        })

        if (!success) {
          throw new Error("DATABASE_SYNC_APPLIED_SEND_FAILED")
        }

        console.log("USB DATABASE_SYNC_APPLIED SENT")
      } catch (error) {
        console.log("USB WINDOWS -> ANDROID APPLY ERROR:", error)

        send({
          type: "DATABASE_SYNC_APPLIED",

          version: 1,

          requestId:
            message?.requestId ||
            databaseSyncRequestRef.current?.requestId ||
            null,

          timestamp: Date.now(),

          payload: {
            success: false,

            syncTime:
              message?.payload?.syncTime ||
              databaseSyncRequestRef.current?.syncTime ||
              null,

            error: error?.message || String(error),

            transport: "usb",
          },
        })

        databaseSyncRunningRef.current = false

        setDatabaseSyncing(false)

        setUsbError(error?.message || "فشل تطبيق بيانات الكمبيوتر.")
      }
    },
    [db, send, verifyAppliedDatabaseChanges],
  )

  // ==========================================================
  // DATABASE COMPLETE
  // ==========================================================

  const handleDatabaseSyncComplete = useCallback(
    async message => {
      try {
        const payload = message?.payload || {}

        console.log("========================================")

        console.log("USB DATABASE_SYNC_COMPLETE")

        console.log("PAYLOAD:", payload)

        console.log("========================================")

        const success = Boolean(payload?.success)

        if (!success) {
          throw new Error(payload?.error || "DATABASE_SYNC_FAILED")
        }

        const syncTime =
          payload?.syncTime || databaseSyncRequestRef.current?.syncTime || null

        const peerId =
          pcDeviceRef.current?.id ||
          databaseSyncRequestRef.current?.peerId ||
          null

        if (!syncTime) {
          throw new Error("SYNC_TIME_MISSING")
        }

        if (!peerId) {
          throw new Error("SYNC_PEER_ID_MISSING")
        }

        setDatabaseProgress(95)

        await setLastSyncAt(db, peerId, syncTime)

        console.log("USB ANDROID LAST SYNC UPDATED:", {
          peerId,

          syncTime,
        })

        setDatabaseProgress(100)

        databaseSyncRequestRef.current = null

        databaseSyncRunningRef.current = false

        setDatabaseSyncing(false)

        setDatabaseSyncSuccess(true)

        setTimeout(() => {
          if (mountedRef.current) {
            setDatabaseSyncSuccess(false)
          }
        }, 4000)

        setUsbError("")

        console.log("========================================")

        console.log("USB DATABASE SYNC FINISHED SUCCESSFULLY")

        console.log("========================================")

        /*
         * بعد إنهاء مزامنة قاعدة البيانات،
         * نبدأ طابور sync_files.
         *
         * لا يتم إنشاء نظام مزامنة جديد.
         */

        // setTimeout(() => {
        //   if (
        //     mountedRef.current &&
        //     connectedRef.current &&
        //     trustedRef.current
        //   ) {
        //     if (syncDatabaseFilesRef.current) {
        //       syncDatabaseFilesRef.current()
        //     }
        //   }
        // }, 300)
      } catch (error) {
        console.log("USB DATABASE_SYNC_COMPLETE ERROR:", error)

        databaseSyncRequestRef.current = null

        databaseSyncRunningRef.current = false

        setDatabaseSyncing(false)

        setUsbError(error?.message || "فشل إنهاء مزامنة قاعدة البيانات.")
      }
    },
    [db],
  )

  // ==========================================================
  // PAIR REQUEST
  // ==========================================================

  const sendPairRequest = useCallback(() => {
    const requestId = createRequestId()

    setPairingRequestId(requestId)

    setPairingState("requesting")

    setPairingCode("")

    const success = send({
      type: "PAIR_REQUEST",

      version: 1,

      requestId,

      timestamp: Date.now(),

      payload: {
        deviceId: deviceIdRef.current,

        transport: "usb",
      },
    })

    if (!success) {
      setPairingState("none")
    }

    return success
  }, [send])

  // ==========================================================
  // CONFIRM PAIRING
  // ==========================================================

  const confirmPairing = useCallback(() => {
    const code = String(pairingCode).trim()

    if (!pairingRequestId) {
      Alert.alert("الاقتران", "لا يوجد طلب اقتران صالح.")

      return
    }

    if (!/^\d{6}$/.test(code)) {
      Alert.alert("رمز غير صحيح", "أدخل رمزًا مكونًا من 6 أرقام.")

      return
    }

    const success = send({
      type: "PAIR_CONFIRM",

      version: 1,

      requestId: pairingRequestId,

      timestamp: Date.now(),

      payload: {
        requestId: pairingRequestId,

        code,
      },
    })

    if (success) {
      setPairingState("confirming")
    }
  }, [pairingCode, pairingRequestId, send])

  // ==========================================================
  // FILE UPDATE
  // ==========================================================

  const setTransfer = useCallback(
    (requestId, patch) => {
      updateTransfer(requestId, patch)
    },
    [updateTransfer],
  )

  // ==========================================================
  // CREATE RECEIVED DIRECTORY
  //
  // نفس منطق SyncScreen:
  //
  // files/
  //   documents/
  //     <entityId>/
  //       <fileName>
  // ==========================================================

  const ensureReceivedDirectory = useCallback(
    async (relativePath, entityId = null) => {
      const baseDirectory = FileSystem.documentDirectory

      if (!baseDirectory) {
        throw new Error("ANDROID_DOCUMENT_DIRECTORY_NOT_AVAILABLE")
      }

      let currentDirectory = `${baseDirectory}documents/`

      const rootInfo = await FileSystem.getInfoAsync(currentDirectory)

      if (!rootInfo.exists) {
        await FileSystem.makeDirectoryAsync(currentDirectory, {
          intermediates: true,
        })
      }

      if (entityId) {
        const safeEntityId = sanitizePathPart(entityId, "folder")

        currentDirectory += `${safeEntityId}/`

        const entityInfo = await FileSystem.getInfoAsync(currentDirectory)

        if (!entityInfo.exists) {
          await FileSystem.makeDirectoryAsync(currentDirectory, {
            intermediates: true,
          })
        }

        console.log("ANDROID RECEIVED DIRECTORY:", currentDirectory)

        return currentDirectory
      }

      let safeRelativePath = normalizeRelativePath(relativePath)

      if (!safeRelativePath) {
        return currentDirectory
      }

      safeRelativePath = safeRelativePath
        .replace(/^avocato[\\/]+files[\\/]+/i, "")
        .replace(/^documents[\\/]+/i, "")

      const parts = safeRelativePath.split("/").filter(Boolean)

      const directoryParts = parts.slice(0, -1)

      for (const part of directoryParts) {
        currentDirectory += `${sanitizePathPart(part, "folder")}/`

        const info = await FileSystem.getInfoAsync(currentDirectory)

        if (!info.exists) {
          await FileSystem.makeDirectoryAsync(currentDirectory, {
            intermediates: true,
          })
        }
      }

      console.log("ANDROID RECEIVED DIRECTORY:", currentDirectory)

      return currentDirectory
    },
    [],
  )

  // ==========================================================
  // GET INCOMING FILE DESTINATION
  // ==========================================================

  const getIncomingFileDestination = useCallback(
    async ({ fileName, relativePath, entityType, entityId }) => {
      const safeFileName = sanitizePathPart(
        fileName || "received-file",
        "received-file",
      )

      const destinationDirectory = await ensureReceivedDirectory(
        relativePath,
        entityId,
      )

      let finalName = safeFileName

      const safeRelative = normalizeRelativePath(relativePath)

      if (safeRelative) {
        const relativeParts = safeRelative.split("/").filter(Boolean)

        if (relativeParts.length > 0) {
          finalName = sanitizePathPart(
            relativeParts[relativeParts.length - 1],
            safeFileName,
          )
        }
      }

      void entityType

      return `${destinationDirectory}${finalName}`
    },
    [ensureReceivedDirectory],
  )

  // ==========================================================
  // FILE SEND ACCEPT
  // PC -> ANDROID
  // ==========================================================

  const sendFileSendAccept = useCallback(
    ({ requestId, transferId, startByte = 0, fileName }) => {
      const success = send({
        type: "FILE_SEND_ACCEPT",

        version: 1,

        requestId,

        transferId,

        timestamp: Date.now(),

        payload: {
          requestId,

          transferId,

          startByte,

          receivedBytes: startByte,

          fileName,

          direction: "PC_TO_ANDROID",
        },
      })

      console.log("USB FILE_SEND_ACCEPT RESULT:", success)

      return success
    },
    [send],
  )

  // ==========================================================
  // FILE COMPLETE
  // PC -> ANDROID
  // ==========================================================

  const sendFileCompleteToPc = useCallback(
    ({ requestId, transferId, pendingFile, receivedBytes }) => {
      const key = `${requestId}:${transferId}`

      if (completedFilesRef.current.has(key)) {
        console.log("USB FILE_COMPLETE ALREADY SENT:", key)

        return true
      }

      const fileSize = Number(
        pendingFile?.size || pendingFile?.fileSize || receivedBytes || 0,
      )

      const success = send({
        type: "FILE_COMPLETE",

        version: 1,

        requestId,

        transferId,

        timestamp: Date.now(),

        payload: {
          requestId,

          transferId,

          fileName: pendingFile?.fileName || pendingFile?.name || "File",

          fileSize,

          receivedBytes: Number(receivedBytes || fileSize || 0),

          uri: pendingFile?.uri || null,

          relativePath: pendingFile?.relativePath || null,

          entityType: pendingFile?.entityType || null,

          entityId: pendingFile?.entityId || null,

          syncFileId: pendingFile?.syncFileId || null,

          direction: "PC_TO_ANDROID",
        },
      })

      console.log("USB FILE_COMPLETE RESULT:", success)

      if (success) {
        completedFilesRef.current.add(key)
      }

      return success
    },
    [send],
  )

  // ==========================================================
  // DOWNLOAD INCOMING FILE
  // PC -> ANDROID
  // ==========================================================

  const downloadIncomingFile = useCallback(
    async data => {
      const {
        requestId,
        transferId,
        fileName,
        fileSize,
        mimeType,
        relativePath,
        entityType,
        entityId,
        syncFileId,
        downloadUrl: incomingDownloadUrl,
        sentBytes,
      } = data

      if (!requestId) {
        throw new Error("REQUEST_ID_MISSING")
      }

      if (!transferId) {
        throw new Error("TRANSFER_ID_MISSING")
      }

      if (!trustedRef.current) {
        throw new Error("DEVICE_NOT_TRUSTED")
      }

      if (typeof AvocatoFlow.downloadFile !== "function") {
        throw new Error("downloadFile غير موجودة في AvocatoFlowModule")
      }

      const normalizedSize = Number(fileSize || 0)

      if (!Number.isFinite(normalizedSize) || normalizedSize < 0) {
        throw new Error("INVALID_FILE_SIZE")
      }

      const normalizedUrl =
        incomingDownloadUrl && /^https?:\/\//i.test(String(incomingDownloadUrl))
          ? String(incomingDownloadUrl)
          : incomingDownloadUrl
            ? `http://${USB_HOST}:${USB_HTTP_PORT}${
                String(incomingDownloadUrl).startsWith("/")
                  ? String(incomingDownloadUrl)
                  : `/${String(incomingDownloadUrl)}`
              }`
            : `http://${USB_HOST}:${USB_HTTP_PORT}/transfer/${encodeURIComponent(
                String(transferId),
              )}`

      const destination = await getIncomingFileDestination({
        fileName,

        relativePath,

        entityType,

        entityId,
      })

      console.log("========================================")

      console.log("USB PC -> ANDROID FILE")

      console.log({
        requestId,

        transferId,

        fileName,

        fileSize: normalizedSize,

        mimeType,

        relativePath,

        entityType,

        entityId,

        syncFileId,

        downloadUrl: normalizedUrl,

        destination,
      })

      console.log("========================================")

      let startByte = Number(sentBytes || 0)

      if (!Number.isFinite(startByte) || startByte < 0) {
        startByte = 0
      }

      if (normalizedSize > 0 && startByte > normalizedSize) {
        startByte = 0
      }

      // ==========================================================
      // CHECK EXISTING FILE
      // ==========================================================

      const info = await getFileInfoSafe(destination)

      if (info?.exists && !info?.isDirectory) {
        const existingSize = Number(info?.size || 0)

        console.log("USB DESTINATION FILE INFO:", {
          destination,

          existingSize,

          normalizedSize,
        })

        if (normalizedSize > 0 && existingSize === normalizedSize) {
          const pendingFile = {
            requestId,

            transferId,

            name: fileName || "File",

            fileName: fileName || "File",

            size: normalizedSize,

            mimeType: mimeType || "application/octet-stream",

            relativePath: relativePath || fileName || "file",

            entityType: entityType || null,

            entityId: entityId || null,

            syncFileId: syncFileId || null,

            databaseFile: false,

            direction: "PC_TO_ANDROID",

            uri: destination,
          }

          pendingFilesRef.current.set(requestId, pendingFile)

          setTransfer(requestId, {
            transferId,

            transferred: normalizedSize,

            total: normalizedSize,

            progress: 1,

            status: "completed",

            direction: "PC_TO_ANDROID",

            uri: destination,
          })

          sendFileCompleteToPc({
            requestId,

            transferId,

            pendingFile,

            receivedBytes: normalizedSize,
          })

          pendingFilesRef.current.delete(requestId)

          incomingDownloadsRef.current.delete(transferId)

          console.log("USB FILE ALREADY COMPLETE:", {
            requestId,

            transferId,

            destination,

            size: existingSize,
          })

          return {
            requestId,

            transferId,

            destination,

            startByte: normalizedSize,
          }
        }

        if (
          normalizedSize > 0 &&
          existingSize > 0 &&
          existingSize < normalizedSize
        ) {
          startByte = Math.max(startByte, existingSize)

          console.log("USB FILE RESUME:", {
            transferId,

            existingSize,

            normalizedSize,

            startByte,
          })
        }
      }

      // ==========================================================
      // SAVE PENDING FILE
      // ==========================================================

      const pendingFile = {
        requestId,

        transferId,

        name: fileName || "File",

        fileName: fileName || "File",

        size: normalizedSize,

        mimeType: mimeType || "application/octet-stream",

        relativePath: relativePath || fileName || "file",

        entityType: entityType || null,

        entityId: entityId || null,

        syncFileId: syncFileId || null,

        databaseFile: false,

        direction: "PC_TO_ANDROID",

        uri: destination,
      }

      pendingFilesRef.current.set(requestId, pendingFile)

      incomingDownloadsRef.current.set(transferId, {
        requestId,

        transferId,
      })

      setTransfers(previous => {
        const exists = previous.some(item => item.requestId === requestId)

        const item = {
          id: requestId,

          requestId,

          transferId,

          fileName: fileName || "File",

          total: normalizedSize,

          transferred: startByte,

          progress:
            normalizedSize > 0 ? Math.min(1, startByte / normalizedSize) : 0,

          status: "waiting",

          direction: "PC_TO_ANDROID",

          relativePath: relativePath || null,

          entityType: entityType || null,

          entityId: entityId || null,

          syncFileId: syncFileId || null,

          uri: destination,
        }

        if (exists) {
          return previous.map(old =>
            old.requestId === requestId
              ? {
                  ...old,

                  ...item,
                }
              : old,
          )
        }

        return [...previous, item]
      })

      // ==========================================================
      // ACCEPT FILE
      // ==========================================================

      const accepted = sendFileSendAccept({
        requestId,

        transferId,

        startByte,

        fileName,
      })

      if (!accepted) {
        throw new Error("FILE_SEND_ACCEPT_SEND_FAILED")
      }

      updateTransfer(requestId, {
        status: "transferring",

        transferred: startByte,

        total: normalizedSize,

        progress:
          normalizedSize > 0 ? Math.min(1, startByte / normalizedSize) : 0,
      })

      // ==========================================================
      // START NATIVE DOWNLOAD
      // ==========================================================

      console.log("USB DOWNLOAD CALL:", {
        requestId,

        transferId,

        downloadUrl: normalizedUrl,

        destination,

        startByte,

        fileSize: normalizedSize,
      })

      try {
        const result = AvocatoFlow.downloadFile(
          transferId,

          normalizedUrl,

          destination,

          startByte,
        )

        console.log("USB DOWNLOAD RESULT:", result)

        if (result && typeof result.then === "function") {
          result.catch(error => {
            console.log("USB ASYNC DOWNLOAD ERROR:", error)

            markTransferError(
              requestId,

              error?.message || "تعذر تنزيل الملف.",
            )
          })
        }
      } catch (error) {
        console.log("USB DOWNLOAD FILE ERROR:", error)

        throw error
      }

      console.log("USB DOWNLOAD STARTED:", {
        requestId,

        transferId,

        downloadUrl: normalizedUrl,

        destination,

        startByte,

        fileSize: normalizedSize,
      })

      return {
        requestId,

        transferId,

        destination,

        startByte,
      }
    },
    [
      getIncomingFileDestination,
      markTransferError,
      sendFileCompleteToPc,
      sendFileSendAccept,
      setTransfer,
      updateTransfer,
    ],
  )

  // ==========================================================
  // HANDLE INCOMING FILE ERROR
  // ==========================================================

  const handleIncomingFileError = useCallback(
    async ({ requestId, transferId, error }) => {
      if (transferId) {
        incomingDownloadsRef.current.delete(transferId)
      }

      const errorMessage =
        error?.message || error || "فشل استقبال الملف من الكمبيوتر."

      console.log("USB PC -> ANDROID FILE ERROR:", {
        requestId,

        transferId,

        error: errorMessage,
      })

      markTransferError(requestId, String(errorMessage))
    },
    [markTransferError],
  )

  // ==========================================================
  // MARK TRANSFER COMPLETED
  //
  // Android -> PC database files:
  // حذف sync_files بعد نجاح النقل.
  //
  // PC -> Android:
  // لا نحذف sync_files في Android.
  // ==========================================================

  const markTransferCompleted = useCallback(
    async requestId => {
      if (!requestId) {
        return
      }

      console.log("========================================")

      console.log("USB FILE COMPLETE:", requestId)

      const pendingFile = pendingFilesRef.current.get(requestId)

      if (!pendingFile) {
        console.log("USB FILE COMPLETE: PENDING FILE NOT FOUND")

        resolveAutoSyncWaiter(requestId, true)

        return
      }

      const isPcToAndroid = pendingFile.direction === "PC_TO_ANDROID"

      const fileSize = Number(pendingFile.size || 0)

      updateTransfer(requestId, {
        status: "completed",

        progress: 1,

        transferred: fileSize,

        total: fileSize,
      })

      /*
       * ======================================================
       * DELETE sync_files
       *
       * فقط Android -> PC
       * ======================================================
       */

      if (
        !isPcToAndroid &&
        pendingFile.databaseFile &&
        pendingFile.syncFileId
      ) {
        const syncFileId = String(pendingFile.syncFileId)

        console.log("USB SYNC FILE ID TO DELETE:", syncFileId)

        try {
          const beforeDelete = await db
            .select()
            .from(schema.syncFiles)
            .where(eq(schema.syncFiles.id, syncFileId))

          console.log(
            "USB SYNC FILE BEFORE DELETE:",
            JSON.stringify(beforeDelete, null, 2),
          )

          if (beforeDelete.length > 0) {
            const deletedRows = await db
              .delete(schema.syncFiles)
              .where(eq(schema.syncFiles.id, syncFileId))
              .returning()

            console.log(
              "USB SYNC FILE DELETE RESULT:",
              JSON.stringify(deletedRows, null, 2),
            )

            const afterDelete = await db
              .select()
              .from(schema.syncFiles)
              .where(eq(schema.syncFiles.id, syncFileId))

            if (afterDelete.length === 0) {
              console.log("USB SYNC FILE SUCCESSFULLY DELETED:", syncFileId)
            } else {
              console.log("USB SYNC FILE STILL EXISTS:", syncFileId)
            }
          } else {
            console.warn("USB SYNC FILE NOT FOUND BEFORE DELETE:", syncFileId)
          }
        } catch (error) {
          console.log("USB DELETE sync_files ERROR:", error)

          /*
           * لا نعتبر النقل فاشلًا.
           *
           * إذا بقي السجل في sync_files
           * سيتم التعامل معه في المزامنة القادمة.
           */
        }
      }

      pendingFilesRef.current.delete(requestId)

      const transferId = pendingFile.transferId

      if (transferId) {
        incomingDownloadsRef.current.delete(transferId)
      }

      if (autoSyncCurrentRef.current === requestId) {
        autoSyncCurrentRef.current = null
      }

      resolveAutoSyncWaiter(requestId, true)

      const notificationKey = `complete:${requestId}`

      if (!notifiedTransfersRef.current.has(notificationKey)) {
        notifiedTransfersRef.current.add(notificationKey)
      }

      console.log("USB FILE COMPLETE FINISHED:", requestId)

      console.log("========================================")
    },
    [db, resolveAutoSyncWaiter, updateTransfer],
  )

  // ==========================================================
  // VERIFY INCOMING FILE
  // PC -> ANDROID
  // ==========================================================

  const verifyIncomingFile = useCallback(
    async event => {
      const transferId = event?.transferId

      if (!transferId) {
        return
      }

      const requestId =
        event?.requestId || findRequestIdByTransferId(transferId)

      if (!requestId) {
        console.warn(
          "USB NATIVE FILE COMPLETED: REQUEST ID NOT FOUND:",
          transferId,
        )

        return
      }

      const pendingFile = pendingFilesRef.current.get(requestId)

      if (!pendingFile || pendingFile.direction !== "PC_TO_ANDROID") {
        return
      }

      const info = await getFileInfoSafe(pendingFile.uri, 2000)

      const expectedSize = Number(pendingFile.size || 0)

      const actualSize = Number(info?.size || 0)

      console.log("USB NATIVE FILE VERIFY:", {
        requestId,

        transferId,

        uri: pendingFile.uri,

        exists: Boolean(info?.exists),

        expectedSize,

        actualSize,
      })

      if (!info?.exists || info?.isDirectory) {
        await handleIncomingFileError({
          requestId,

          transferId,

          error: "USB_FILE_NOT_SAVED",
        })

        return
      }

      if (expectedSize > 0 && actualSize !== expectedSize) {
        await handleIncomingFileError({
          requestId,

          transferId,

          error: `USB_FILE_SIZE_MISMATCH: expected=${expectedSize}, received=${actualSize}`,
        })

        return
      }

      updateTransfer(requestId, {
        status: "completed",

        transferred: expectedSize > 0 ? expectedSize : actualSize,

        total: expectedSize > 0 ? expectedSize : actualSize,

        progress: 1,

        uri: pendingFile.uri,
      })

      const success = sendFileCompleteToPc({
        requestId,

        transferId,

        pendingFile,

        receivedBytes: expectedSize > 0 ? expectedSize : actualSize,
      })

      if (!success) {
        await handleIncomingFileError({
          requestId,

          transferId,

          error: "FILE_COMPLETE_SEND_FAILED",
        })

        return
      }

      await markTransferCompleted(requestId)

      console.log("USB NATIVE FILE COMPLETED SUCCESSFULLY:", {
        requestId,

        transferId,

        destination: pendingFile.uri,
      })
    },
    [
      findRequestIdByTransferId,
      handleIncomingFileError,
      markTransferCompleted,
      sendFileCompleteToPc,
      updateTransfer,
    ],
  )

  // ==========================================================
  // WAIT FOR DATABASE FILE
  // ==========================================================

  const waitForDatabaseFile = useCallback(requestId => {
    return new Promise((resolve, reject) => {
      if (!requestId) {
        reject(new Error("INVALID_REQUEST_ID"))

        return
      }

      autoSyncWaitersRef.current.set(requestId, {
        resolve,

        reject,
      })

      console.log("USB AUTO SYNC WAITER REGISTERED:", requestId)
    })
  }, [])

  // ==========================================================
  // SEND DATABASE FILE
  //
  // Android -> PC
  // ==========================================================

  const sendDatabaseFile = useCallback(
    async file => {
      if (!file?.uri) {
        console.warn("USB SYNC FILE URI MISSING:", file)

        return null
      }

      if (!connectedRef.current) {
        return null
      }

      if (!trustedRef.current) {
        return null
      }

      const syncFileId = String(file.id)

      const requestId = `usb-dbfile-${syncFileId}-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 8)}`

      const fileSize = Number(file.size || 0)

      const pendingFile = {
        uri: file.uri,

        name: file.fileName || "file",

        size: fileSize,

        mimeType: file.mimeType || "application/octet-stream",

        relativePath: file.relativePath || file.fileName || "file",

        entityType: file.entityType || null,

        entityId: file.entityId || null,

        syncFileId,

        requestId,

        transferId: null,

        databaseFile: true,

        direction: "ANDROID_TO_PC",
      }

      pendingFilesRef.current.set(requestId, pendingFile)

      setTransfers(previous => [
        ...previous,

        {
          id: requestId,

          requestId,

          transferId: null,

          fileName: file.fileName || "File",

          total: fileSize,

          transferred: 0,

          progress: 0,

          status: "waiting",

          direction: "ANDROID_TO_PC",

          syncFileId,
        },
      ])

      const completionPromise = waitForDatabaseFile(requestId)

      try {
        console.log("========================================")

        console.log("USB AUTO SYNC FILE_REQUEST")

        console.log({
          requestId,

          syncFileId,

          fileName: file.fileName,

          size: fileSize,

          uri: file.uri,

          relativePath: file.relativePath,

          entityType: file.entityType,

          entityId: file.entityId,
        })

        console.log("========================================")

        const success = send({
          type: "FILE_REQUEST",

          version: 1,

          requestId,

          timestamp: Date.now(),

          payload: {
            requestId,

            fileName: file.fileName || "file",

            fileSize,

            mimeType: file.mimeType || "application/octet-stream",

            relativePath: file.relativePath || file.fileName || "file",

            entityType: file.entityType || null,

            entityId: file.entityId || null,

            syncFileId,
          },
        })

        if (!success) {
          throw new Error("FILE_REQUEST_SEND_FAILED")
        }

        console.log("USB DATABASE FILE_REQUEST SENT:", {
          requestId,

          syncFileId,
        })

        return {
          requestId,

          completionPromise,
        }
      } catch (error) {
        console.log("USB DATABASE FILE REQUEST ERROR:", error)

        autoSyncWaitersRef.current.delete(requestId)

        markTransferError(
          requestId,

          error?.message || "تعذر إرسال طلب الملف.",
        )

        return null
      }
    },
    [markTransferError, send, waitForDatabaseFile],
  )

  // ==========================================================
  // DATABASE FILE AUTO SYNC
  //
  // sync_files -> FILE_REQUEST
  // -> FILE_ACCEPT
  // -> uploadFile
  // -> native completed
  // -> DELETE sync_files
  // ==========================================================

  // const syncDatabaseFiles = useCallback(async () => {
  //   console.log("=== USB DATABASE FILE AUTO SYNC START ===")

  //   if (!connectedRef.current) {
  //     console.log("USB AUTO SYNC STOP: NO CONNECTED DEVICE")

  //     return
  //   }

  //   if (!trustedRef.current) {
  //     console.log("USB AUTO SYNC STOP: DEVICE NOT TRUSTED")

  //     return
  //   }

  //   if (autoSyncStartedRef.current) {
  //     console.log("USB AUTO SYNC STOP: ALREADY RUNNING")

  //     return
  //   }

  //   autoSyncStartedRef.current = true

  //   setFileSyncing(true)

  //   try {
  //     console.log("USB AUTO SYNC: LOADING sync_files...")

  //     const files = await db.select().from(schema.syncFiles)

  //     console.log("USB AUTO SYNC FILES:", files)

  //     if (files.length === 0) {
  //       console.log("USB AUTO SYNC: sync_files IS EMPTY")

  //       return
  //     }

  //     autoSyncQueueRef.current = files.slice()

  //     for (const file of files) {
  //       if (!connectedRef.current || !trustedRef.current) {
  //         console.log("USB AUTO SYNC STOP: CONNECTION LOST")

  //         break
  //       }

  //       if (!file?.uri) {
  //         console.warn("USB AUTO SYNC SKIP: URI MISSING", file)

  //         continue
  //       }

  //       if (autoSyncFilesRef.current.has(file.id)) {
  //         console.log("USB AUTO SYNC SKIP: ALREADY SENT", file.id)

  //         continue
  //       }

  //       autoSyncFilesRef.current.add(file.id)

  //       console.log("USB AUTO SYNC SENDING:", {
  //         id: file.id,

  //         fileName: file.fileName,

  //         uri: file.uri,

  //         size: file.size,

  //         relativePath: file.relativePath,

  //         entityType: file.entityType,

  //         entityId: file.entityId,
  //       })

  //       try {
  //         const result = await sendDatabaseFile(file)

  //         if (!result?.requestId || !result?.completionPromise) {
  //           throw new Error("FILE_REQUEST_FAILED")
  //         }

  //         autoSyncCurrentRef.current = result.requestId

  //         await result.completionPromise

  //         console.log("USB AUTO SYNC COMPLETED:", file.fileName)
  //       } catch (error) {
  //         console.log("USB AUTO SYNC FILE ERROR:", file.fileName, error)

  //         autoSyncFilesRef.current.delete(file.id)

  //         autoSyncCurrentRef.current = null

  //         if (error?.message === "CONNECTION_CLOSED") {
  //           console.log("USB AUTO SYNC STOPPED: CONNECTION_CLOSED")

  //           break
  //         }
  //       }

  //       await new Promise(resolve => setTimeout(resolve, 150))
  //     }
  //   } catch (error) {
  //     console.log("USB DATABASE FILE AUTO SYNC ERROR:", error)
  //   } finally {
  //     autoSyncStartedRef.current = false

  //     autoSyncCurrentRef.current = null

  //     autoSyncQueueRef.current = []

  //     setFileSyncing(false)

  //     console.log("=== USB DATABASE FILE AUTO SYNC FINISHED ===")
  //   }
  // }, [db, sendDatabaseFile])

  // useEffect(() => {
  //   syncDatabaseFilesRef.current = syncDatabaseFiles
  // }, [syncDatabaseFiles])

  // ==========================================================
  // HANDLE MESSAGE
  // ==========================================================

  const handleMessage = useCallback(
    async incoming => {
      console.log("USB AVOCATO FLOW MESSAGE:", incoming)

      const message = parseIncomingMessage(incoming)

      if (!message) {
        return
      }

      console.log("USB PARSED MESSAGE:", message)

      setLastMessage(message)

      setMessageCount(previous => previous + 1)

      const type = message?.type

      const payload = message?.payload || {}

      // ======================================================
      // WELCOME
      // ======================================================

      if (type === "WELCOME") {
        console.log("USB SERVER WELCOME:", message)

        const device = createUsbPcDevice({
          id: payload?.id || "usb-pc",

          name: payload?.name || "Avocato Desktop",

          platform: payload?.platform || "windows",

          trusted: payload?.trusted === true,
        })

        pcDeviceRef.current = device

        setPcDevice(device)

        connectedRef.current = true

        setUsbConnected(true)

        setUsbStatus("connected")

        setUsbError("")

        const isTrusted = payload?.trusted === true

        trustedRef.current = isTrusted

        setTrusted(isTrusted)

        if (isTrusted) {
          setPairingState("trusted")

          setPairingRequestId("")

          setPairingCode("")

          await saveTrustedUsb(device)

          /*
           * Database Sync سيبدأ بعد
           * مرور حالة الاتصال إلى connected
           * عبر useEffect.
           *
           * لا نشغل file sync هنا حتى لا
           * يتكرر أكثر من مرة.
           */
        }

        return
      }

      // ======================================================
      // PAIR_ALREADY_TRUSTED
      // ======================================================

      if (type === "PAIR_ALREADY_TRUSTED") {
        console.log("USB PC IS ALREADY TRUSTED")

        trustedRef.current = true

        setTrusted(true)

        setPairingState("trusted")

        const current = pcDeviceRef.current || createUsbPcDevice()

        const device = createUsbPcDevice({
          ...current,

          trusted: true,

          id: current.id || "usb-pc",

          name: current.name || "Avocato Desktop",
        })

        await saveTrustedUsb(device)

        return
      }

      
if (type === "CASE_FILES_SYNC_COMPLETE") {
  const payload = message?.payload || {}

  console.log("========================================")
  console.log("USB CASE FILES SYNC COMPLETE:", payload)
  console.log("========================================")

  caseFilesSyncRunningRef.current = false
  caseFilesSyncRequestRef.current = null

  if (payload?.success === false) {
    setUsbError(
      payload?.error ||
        payload?.message ||
        "فشلت مزامنة ملفات القضايا.",
    )

    return
  }

  setCaseFilesSyncSuccess(true)
  setUsbError("")

  setTimeout(() => {
    if (mountedRef.current) {
      setCaseFilesSyncSuccess(false)
    }
  }, 4000)

  return
}


      // ======================================================
      // PAIR_CODE
      // ======================================================

      if (type === "PAIR_CODE") {
        const requestId = payload?.requestId || message?.requestId || ""

        const code = payload?.code || ""

        setPairingRequestId(String(requestId))

        // setPairingCode(String(code))

        setPairingState("code_received")

        setUsbError("")

        return
      }

      // ======================================================
      // PAIR_ACCEPT
      // ======================================================

      if (type === "PAIR_ACCEPT") {
        trustedRef.current = true

        setTrusted(true)

        setPairingState("paired")

        setPairingRequestId("")

        setPairingCode("")

        setUsbError("")

        const current = pcDeviceRef.current || createUsbPcDevice()

        await saveTrustedUsb({
          ...current,

          trusted: true,
        })

        Alert.alert("تم الاقتران", "تم ربط الهاتف بالكمبيوتر بنجاح.")

        return
      }

      // ======================================================
      // PAIR_REJECT
      // ======================================================

      if (type === "PAIR_REJECT") {
        setPairingState("rejected")

        setUsbError(
          payload?.reason || payload?.message || "كود الاقتران غير صحيح.",
        )

        return
      }

      // ======================================================
      // DATABASE_SYNC_DATA
      // ======================================================

      if (type === "DATABASE_SYNC_DATA") {
        await handleDatabaseSyncData(message)

        return
      }

      // ======================================================
      // DATABASE_SYNC_COMPLETE
      // ======================================================

      if (type === "DATABASE_SYNC_COMPLETE") {
        await handleDatabaseSyncComplete(message)

        return
      }

      // ======================================================
      // DATABASE_SYNC_ERROR
      // ======================================================

      if (type === "DATABASE_SYNC_ERROR") {
        console.log("USB DATABASE SYNC ERROR:", payload)

        databaseSyncRunningRef.current = false

        databaseSyncRequestRef.current = null

        setDatabaseSyncing(false)

        setUsbError(
          payload?.message ||
            payload?.error ||
            payload?.code ||
            "DATABASE_SYNC_ERROR",
        )

        return
      }

      // ======================================================
      // TEST RESPONSE
      // ======================================================

      if (type === "TEST_RESPONSE") {
        Alert.alert("نجاح", "تم الاتصال بالكمبيوتر عبر USB.")

        return
      }

      // ======================================================
      // PING
      // ======================================================

      if (type === "PING") {
        send({
          type: "PONG",

          version: 1,

          requestId: message?.requestId,

          timestamp: Date.now(),

          payload: {
            timestamp: Date.now(),
          },
        })

        return
      }

      // ======================================================
      // CASE_FILES_UPLOAD_REQUESTS
      // PC -> ANDROID
      // Android must upload remoteOnly case files
      // ======================================================

      if (type === "CASE_FILES_UPLOAD_REQUESTS") {
        const requests = payload?.requests || message?.requests || []

        console.log("========================================")

        console.log("USB CASE_FILES_UPLOAD_REQUESTS RECEIVED:", {
          count: Array.isArray(requests) ? requests.length : 0,

          requests,
        })

        console.log("========================================")

        await handleCaseFilesUploadRequests(requests)

        return
      }

      // ======================================================
      // FILE_SEND_REQUEST
      // PC -> ANDROID
      // ======================================================

      if (type === "FILE_SEND_REQUEST") {
        const requestId = message?.requestId || payload?.requestId

        const transferId = message?.transferId || payload?.transferId

        const fileName = payload?.fileName || message?.fileName || "File"

        const fileSize = Number(payload?.fileSize ?? message?.fileSize ?? 0)

        const mimeType =
          payload?.mimeType || message?.mimeType || "application/octet-stream"

        const relativePath =
          payload?.relativePath || message?.relativePath || null

        const entityType = payload?.entityType || message?.entityType || null

        const entityId = payload?.entityId || message?.entityId || null

        const syncFileId = payload?.syncFileId || message?.syncFileId || null

        console.log("========================================")

        console.log("USB FILE_SEND_REQUEST RECEIVED:", {
          requestId,

          transferId,

          fileName,

          fileSize,

          mimeType,

          relativePath,

          entityType,

          entityId,

          syncFileId,
        })

        console.log("========================================")

        if (!trustedRef.current) {
          console.log("USB FILE_SEND_REQUEST REJECTED: DEVICE_NOT_TRUSTED")

          send({
            type: "FILE_REJECT",

            version: 1,

            requestId,

            transferId,

            timestamp: Date.now(),

            payload: {
              requestId,

              transferId,

              code: "DEVICE_NOT_TRUSTED",

              message: "الجهاز غير موثوق.",
            },
          })

          return
        }

        if (!requestId) {
          console.log("USB FILE_SEND_REQUEST: REQUEST ID MISSING")

          return
        }

        if (!transferId) {
          console.log("USB FILE_SEND_REQUEST: TRANSFER ID MISSING")

          return
        }

        if (!Number.isFinite(fileSize) || fileSize < 0) {
          console.log("USB FILE_SEND_REQUEST: INVALID FILE SIZE")

          return
        }

        const existingRequest = pendingFilesRef.current.get(requestId)

        if (existingRequest && existingRequest.direction === "PC_TO_ANDROID") {
          console.log("USB FILE_SEND_REQUEST DUPLICATE:", requestId)

          return
        }

        downloadIncomingFile({
          requestId,

          transferId,

          fileName,

          fileSize,

          mimeType,

          relativePath,

          entityType,

          entityId,

          syncFileId,
        }).catch(async error => {
          console.log("USB PC -> ANDROID DOWNLOAD ERROR:", error)

          await handleIncomingFileError({
            requestId,

            transferId,

            error: error?.message || String(error),
          })

          send({
            type: "FILE_ERROR",

            version: 1,

            requestId,

            transferId,

            timestamp: Date.now(),

            payload: {
              requestId,

              transferId,

              message: error?.message || "فشل تنزيل الملف.",

              error: error?.message || String(error),

              direction: pendingFile?.direction || "PC_TO_ANDROID",
              caseFileSync: pendingFile?.caseFileSync === true,
            },
          })
        })

        return
      }

      // ======================================================
      // FILE_ACCEPT
      // ANDROID -> PC
      // ======================================================

      if (type === "FILE_ACCEPT") {
        const requestId = message?.requestId || payload?.requestId

        const transferId = payload?.transferId || message?.transferId

        const uploadUrl = payload?.uploadUrl || message?.uploadUrl

        const startByte = Number(
          payload?.receivedBytes ?? payload?.startByte ?? payload?.offset ?? 0,
        )

        if (!transferId) {
          console.log("USB INVALID FILE_ACCEPT: TRANSFER ID MISSING")

          return
        }

        if (!uploadUrl) {
          console.log("USB INVALID FILE_ACCEPT: UPLOAD URL MISSING")

          return
        }

        let resolvedRequestId = requestId

        let pendingFile = requestId
          ? pendingFilesRef.current.get(requestId)
          : null

        if (!pendingFile) {
          const foundRequestId = findRequestIdByTransferId(transferId)

          if (foundRequestId) {
            resolvedRequestId = foundRequestId

            pendingFile = pendingFilesRef.current.get(foundRequestId)
          }
        }

        if (!pendingFile) {
          console.log("USB PENDING FILE NOT FOUND:", {
            requestId,

            transferId,

            pendingFiles: Array.from(pendingFilesRef.current.keys()),
          })

          return
        }

        const normalizedUrl = /^https?:\/\//i.test(uploadUrl)
          ? uploadUrl
          : `http://${USB_HOST}:${USB_HTTP_PORT}${
              uploadUrl.startsWith("/") ? uploadUrl : `/${uploadUrl}`
            }`

        const updatedPendingFile = {
          ...pendingFile,

          requestId: resolvedRequestId,

          transferId,
        }

        pendingFilesRef.current.set(resolvedRequestId, updatedPendingFile)

        const fileSize = Number(pendingFile.size || 0)

        setTransfer(resolvedRequestId, {
          transferId,

          transferred: startByte,

          total: fileSize,

          progress: fileSize > 0 ? Math.min(1, startByte / fileSize) : 0,

          status: "transferring",
        })

        console.log("USB UPLOAD STARTED:", {
          requestId: resolvedRequestId,

          transferId,

          normalizedUrl,

          startByte,
        })

        try {
          const result = AvocatoFlow.uploadFile(
            pendingFile.uri,

            transferId,

            normalizedUrl,

            startByte,
          )

          console.log("USB UPLOAD RESULT:", result)

          if (result && typeof result.then === "function") {
            result.catch(error => {
              console.log("USB ASYNC UPLOAD ERROR:", error)

              markTransferError(
                resolvedRequestId,

                error?.message || "تعذر نقل الملف.",
              )
            })
          }
        } catch (error) {
          console.log("USB UPLOAD FILE ERROR:", error)

          markTransferError(
            resolvedRequestId,

            error?.message || "تعذر بدء نقل الملف.",
          )
        }

        return
      }

      // ======================================================
      // FILE_SEND_ACCEPT
      // ======================================================

      if (type === "FILE_SEND_ACCEPT") {
        console.log("USB FILE_SEND_ACCEPT:", message)

        return
      }

      // ======================================================
      // FILE_REJECT
      // ======================================================

      if (type === "FILE_REJECT") {
        const requestId = resolveRequestId(message, payload)

        const errorMessage =
          payload?.message || payload?.error || "رفض الكمبيوتر نقل الملف."

        if (requestId) {
          markTransferError(requestId, errorMessage)
        } else {
          Alert.alert("رفض نقل الملف", errorMessage)
        }

        return
      }

      // ======================================================
      // FILE_PROGRESS
      // ======================================================

      if (type === "FILE_PROGRESS") {
        const transferId = payload?.transferId || message?.transferId

        const requestId = resolveRequestId(message, payload)

        if (!requestId) {
          return
        }

        const transferred = Number(
          payload?.transferred ??
            payload?.receivedBytes ??
            payload?.transferredBytes ??
            payload?.bytesTransferred ??
            payload?.sentBytes ??
            0,
        )

        const total = Number(payload?.total ?? payload?.fileSize ?? 0)

        setTransfers(previous =>
          previous.map(item => {
            if (item.requestId !== requestId) {
              return item
            }

            const currentTransferred = Number(item.transferred || 0)

            const isIncoming = item.direction === "PC_TO_ANDROID"

            const finalTransferred = isIncoming
              ? Math.max(currentTransferred, transferred)
              : transferred

            const finalTotal = total || item.total || 0

            return {
              ...item,

              transferId: transferId || item.transferId,

              transferred:
                finalTotal > 0
                  ? Math.min(finalTransferred, finalTotal)
                  : finalTransferred,

              total: finalTotal,

              progress:
                finalTotal > 0 ? Math.min(1, finalTransferred / finalTotal) : 0,

              status:
                item.status === "completed" ? "completed" : "transferring",
            }
          }),
        )

        return
      }

      // ======================================================
      // FILE_COMPLETE
      // ======================================================

      if (type === "FILE_COMPLETE") {
        const transferId = payload?.transferId || message?.transferId

        const requestId = resolveRequestId(message, payload)

        console.log(
          "USB FILE_COMPLETE MESSAGE:",
          JSON.stringify(message, null, 2),
        )

        if (requestId) {
          const pendingFile = pendingFilesRef.current.get(requestId)

          if (pendingFile?.direction === "PC_TO_ANDROID") {
            await verifyIncomingFile({
              requestId,

              transferId,
            })
          } else {
            await markTransferCompleted(requestId)
          }
        } else {
          console.warn("USB FILE_COMPLETE: REQUEST ID NOT FOUND:", {
            transferId,
          })
        }

        return
      }

      // ======================================================
      // FILE_ERROR
      // ======================================================

      if (type === "FILE_ERROR") {
        const transferId = payload?.transferId || message?.transferId

        const requestId = resolveRequestId(message, payload)

        const errorMessage =
          payload?.message ||
          payload?.error ||
          message?.error ||
          "فشل نقل الملف."

        console.log("USB FILE ERROR:", {
          requestId,

          transferId,

          error: errorMessage,
        })

        if (requestId) {
          await handleIncomingFileError({
            requestId,

            transferId,

            error: errorMessage,
          })
        } else {
          Alert.alert("خطأ في نقل الملف", errorMessage)
        }

        return
      }

      // ======================================================
      // ERROR
      // ======================================================

      if (type === "ERROR") {
        setUsbError(payload?.message || payload?.error || "حدث خطأ في USB.")

        return
      }
    },
    [
      downloadIncomingFile,
      handleDatabaseSyncComplete,
      handleDatabaseSyncData,
      handleIncomingFileError,
      markTransferCompleted,
      verifyIncomingFile,
      markTransferError,
      resolveRequestId,
      saveTrustedUsb,
      send,
      setTransfer,
      startDatabaseSync,
      updateTransfer,
      handleCaseFilesUploadRequests,
    ],
  )

  // ==========================================================
  // HANDLE CONNECTION STATE
  // ==========================================================

  const handleConnectionState = useCallback(
    event => {
      console.log("USB FLOW CONNECTION STATE:", event)

      const connected = Boolean(event?.connected)

      if (connected) {
        console.log("USB FLOW: CONNECTION ESTABLISHED")

        connectedRef.current = true
        connectingRef.current = false
        connectionOfflineRef.current = false
        reconnectAttemptRef.current = 0

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }

        setUsbConnected(true)
        setUsbStatus("connected")
        setUsbError("")

        return
      }

      console.log("USB FLOW: CONNECTION LOST")

      const wasConnected = connectedRef.current

      connectedRef.current = false
      connectingRef.current = false

      setUsbConnected(false)

      if (wasConnected) {
        console.log("USB FLOW: REMOTE DISCONNECT - PC CLOSED OR SOCKET CLOSED")

        connectionOfflineRef.current = true

        setUsbStatus("offline")
        setUsbError("في انتظار تشغيل Avocato Desktop...")

        databaseSyncRunningRef.current = false
        databaseSyncRequestRef.current = null

        setDatabaseSyncing(false)

        autoSyncStartedRef.current = false
        autoSyncCurrentRef.current = null

        setFileSyncing(false)

        for (const [requestId, waiter] of autoSyncWaitersRef.current) {
          try {
            waiter.reject(new Error("CONNECTION_CLOSED"))
          } catch (_) {}
        }

        autoSyncWaitersRef.current.clear()

        scheduleUsbReconnect()

        return
      }

      setUsbStatus("disconnected")
    },
    [scheduleUsbReconnect],
  )
  // ==========================================================
  // HANDLE CONNECTION ERROR
  // ==========================================================

  const handleConnectionError = useCallback(
    event => {
      const message = String(event?.error?.message || event?.error || "")

      console.log("USB FLOW CONNECTION ERROR:", message)

      const wasConnected = connectedRef.current

      const isExpectedSocketClose =
        message.includes("WebSocket connection failed") ||
        message.includes("WebSocket closed") ||
        message.includes("socket closed") ||
        message.includes("connection closed") ||
        message.includes("ECONNRESET") ||
        message.includes("ECONNABORTED") ||
        message.includes("127.0.0.1:47822")

      if (wasConnected || isExpectedSocketClose) {
        console.log("USB FLOW: TREATING ERROR AS DISCONNECT")

        connectionOfflineRef.current = true

        connectedRef.current = false
        connectingRef.current = false

        setUsbConnected(false)
        setUsbStatus("offline")

        setUsbError(
          "تم إغلاق الاتصال بالكمبيوتر. في انتظار تشغيل Avocato Desktop...",
        )

        databaseSyncRunningRef.current = false
        databaseSyncRequestRef.current = null

        setDatabaseSyncing(false)

        autoSyncStartedRef.current = false
        autoSyncCurrentRef.current = null

        setFileSyncing(false)

        for (const [requestId, waiter] of autoSyncWaitersRef.current) {
          try {
            waiter.reject(new Error("CONNECTION_CLOSED"))
          } catch (_) {}
        }

        autoSyncWaitersRef.current.clear()

        scheduleUsbReconnect()

        return
      }

      console.log("USB CONNECTION REAL ERROR:", event)

      connectionOfflineRef.current = false
      connectingRef.current = false
      connectedRef.current = false

      setUsbConnected(false)
      setUsbStatus("error")

      setDatabaseSyncing(false)
      setFileSyncing(false)

      databaseSyncRunningRef.current = false
      databaseSyncRequestRef.current = null

      autoSyncStartedRef.current = false
      autoSyncCurrentRef.current = null

      for (const [requestId, waiter] of autoSyncWaitersRef.current) {
        try {
          waiter.reject(new Error("CONNECTION_CLOSED"))
        } catch (_) {}
      }

      autoSyncWaitersRef.current.clear()

      setUsbError(message || "تعذر الاتصال عبر USB.")
    },
    [scheduleUsbReconnect],
  )

  // ==========================================================
  // CONNECT USB
  // ==========================================================

  const connectUsb = useCallback(async () => {
    if (manualDisconnectRef.current) {
      return
    }

    if (connectingRef.current) {
      return
    }

    if (connectedRef.current) {
      return
    }
    manualDisconnectRef.current = false
    connectingRef.current = true

    setUsbStatus("connecting")
    setUsbError("")

    try {
      await loadDeviceId()

      const trustedPc = await loadTrustedUsb()

      if (trustedPc) {
        const device = createUsbPcDevice({
          ...trustedPc,
          trusted: true,
        })

        pcDeviceRef.current = device
        setPcDevice(device)

        trustedRef.current = true
        setTrusted(true)
      }

      console.log("USB AVOCATO FLOW CONNECT:", {
        host: USB_HOST,
        port: USB_WS_PORT,
      })

      const result = AvocatoFlow.connect(USB_HOST, USB_WS_PORT)

      console.log("USB CONNECT RESULT:", result)
    } catch (error) {
      const message = String(error?.message || error || "")

      const isComputerOffline =
        message.includes("Failed to connect") ||
        message.includes("Connection refused") ||
        message.includes("ECONNREFUSED") ||
        message.includes("127.0.0.1:47822") ||
        message.includes("WebSocket connection failed")

      connectingRef.current = false
      connectedRef.current = false

      setUsbConnected(false)

      if (isComputerOffline) {
        connectionOfflineRef.current = true

        console.log("USB CONNECT: COMPUTER OFFLINE", message)

        setUsbStatus("offline")
        setUsbError("")

        return
      }

      console.log("USB CONNECT ERROR:", error)

      setUsbStatus("error")

      setUsbError(message || "تعذر الاتصال عبر USB.")
    }
  }, [loadDeviceId, loadTrustedUsb])

  const scheduleUsbReconnect = useCallback(() => {
    if (manualDisconnectRef.current) {
      return
    }

    if (connectedRef.current || connectingRef.current) {
      return
    }

    if (reconnectTimerRef.current) {
      return
    }

    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt

    // 2 ثوانٍ في البداية، ثم تصل تدريجيًا إلى 5 ثوانٍ كحد أقصى
    const delay = Math.min(2000 + (attempt - 1) * 1000, 5000)

    console.log("USB AUTO RECONNECT SCHEDULED:", {
      attempt,
      delay,
    })

    setUsbStatus("offline")
    setUsbError("في انتظار تشغيل Avocato Desktop...")

    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null

      if (!mountedRef.current) {
        return
      }

      if (manualDisconnectRef.current) {
        return
      }

      if (connectedRef.current || connectingRef.current) {
        return
      }

      console.log("USB AUTO RECONNECT TRY:", attempt)

      try {
        await connectUsb()

        // connectUsb قد لا يرمي exception لأن الاتصال يتم native async
        // لذلك إذا لم يحدث connected event سنعيد المحاولة من هنا.
        setTimeout(() => {
          if (
            mountedRef.current &&
            !manualDisconnectRef.current &&
            !connectedRef.current &&
            !connectingRef.current
          ) {
            scheduleUsbReconnect()
          }
        }, 1500)
      } catch (error) {
        console.warn("USB AUTO RECONNECT ERROR:", error?.message || error)

        if (mountedRef.current && !manualDisconnectRef.current) {
          scheduleUsbReconnect()
        }
      }
    }, delay)
  }, [connectUsb])
  // ==========================================================
  // DISCONNECT
  // ==========================================================

  const disconnectUsb = useCallback(() => {
    manualDisconnectRef.current = true

    connectionOfflineRef.current = false
    reconnectAttemptRef.current = 0

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    for (const [requestId, waiter] of autoSyncWaitersRef.current) {
      try {
        waiter.reject(new Error("CONNECTION_CLOSED"))
      } catch (_) {}
    }

    autoSyncWaitersRef.current.clear()

    autoSyncStartedRef.current = false
    autoSyncCurrentRef.current = null

    setFileSyncing(false)

    try {
      AvocatoFlow.disconnect()
    } catch (error) {
      console.warn("USB DISCONNECT ERROR:", error)
    }

    connectedRef.current = false
    connectingRef.current = false

    databaseSyncRunningRef.current = false
    databaseSyncRequestRef.current = null

    setUsbConnected(false)
    setUsbStatus("disconnected")
    setDatabaseSyncing(false)
    setUsbError("")
  }, [])

  // ==========================================================
  // UNPAIR
  // ==========================================================

  const unpair = useCallback(async () => {
    try {
      send({
        type: "UNPAIR",

        version: 1,

        requestId: createRequestId(),

        timestamp: Date.now(),

        payload: {
          deviceId: pcDeviceRef.current?.id || null,

          transport: "usb",
        },
      })
    } catch (error) {
      console.warn("USB UNPAIR SEND ERROR:", error)
    }

    await AsyncStorage.removeItem(TRUSTED_USB_KEY)

    trustedRef.current = false

    setTrusted(false)

    setPairingState("none")

    setPairingRequestId("")

    setPairingCode("")

    setPcDevice(null)

    pcDeviceRef.current = null

    Alert.alert("تم", "تم إلغاء اقتران الكمبيوتر.")
  }, [send])

  // ==========================================================
  // TEST MESSAGE
  // ==========================================================

  const sendTestMessage = useCallback(() => {
    if (!connectedRef.current) {
      Alert.alert("USB", "لا يوجد اتصال بالكمبيوتر.")

      return
    }

    if (!trustedRef.current) {
      Alert.alert("USB", "يجب إتمام الاقتران أولًا.")

      return
    }

    send({
      type: "TEST_MESSAGE",

      version: 1,

      requestId: createRequestId(),

      timestamp: Date.now(),

      payload: {
        message: "HELLO FROM ANDROID USB",

        deviceId: deviceIdRef.current,

        transport: "usb",
      },
    })
  }, [send])

  // ==========================================================
  // INITIALIZE LISTENERS
  // ==========================================================

  useEffect(() => {
    mountedRef.current = true

    let messageSubscription = null

    let stateSubscription = null

    let errorSubscription = null

    let fileProgressSubscription = null

    let fileCompletedSubscription = null

    let fileErrorSubscription = null

    const initialize = async () => {
      try {
        const id = await loadDeviceId()

        const trustedPc = await loadTrustedUsb()

        if (trustedPc) {
          const device = createUsbPcDevice({
            ...trustedPc,

            trusted: true,
          })

          pcDeviceRef.current = device

          setPcDevice(device)

          trustedRef.current = true

          setTrusted(true)

          setPairingState("trusted")
        }

        messageSubscription = AvocatoFlow.addListener(
          "onMessage",
          handleMessage,
        )

        stateSubscription = AvocatoFlow.addListener(
          "onConnectionStateChanged",
          handleConnectionState,
        )

        errorSubscription = AvocatoFlow.addListener(
          "onConnectionError",
          handleConnectionError,
        )

        fileProgressSubscription = AvocatoFlow.addListener(
          "onFileProgress",
          event => {
            const transferId = event?.transferId

            if (!transferId) {
              return
            }

            const requestId =
              event?.requestId || findRequestIdByTransferId(transferId)

            if (!requestId) {
              return
            }

            const transferred = Number(
              event?.transferred ??
                event?.receivedBytes ??
                event?.downloaded ??
                0,
            )

            const total = Number(event?.total ?? event?.fileSize ?? 0)

            setTransfers(previous =>
              previous.map(item => {
                if (item.requestId !== requestId) {
                  return item
                }

                const finalTotal = total || item.total || 0

                const finalTransferred =
                  finalTotal > 0
                    ? Math.min(Math.max(transferred, 0), finalTotal)
                    : Math.max(transferred, 0)

                return {
                  ...item,

                  transferId,

                  transferred: finalTransferred,

                  total: finalTotal,

                  progress: finalTotal > 0 ? finalTransferred / finalTotal : 0,

                  status:
                    item.status === "completed" ? "completed" : "transferring",
                }
              }),
            )
          },
        )

        fileCompletedSubscription = AvocatoFlow.addListener(
          "onFileCompleted",
          event => {
            verifyIncomingFile(event).catch(error => {
              console.log("USB NATIVE FILE COMPLETED HANDLER ERROR:", error)
            })
          },
        )

        fileErrorSubscription = AvocatoFlow.addListener(
          "onFileError",
          event => {
            const transferId = event?.transferId

            const requestId =
              event?.requestId ||
              (transferId ? findRequestIdByTransferId(transferId) : null)

            if (!requestId) {
              console.log("USB NATIVE FILE ERROR REQUEST ID NOT FOUND:", event)

              return
            }

            handleIncomingFileError({
              requestId,

              transferId,

              error: event?.error || "فشل نقل الملف.",
            }).catch(error => {
              console.log("USB NATIVE FILE ERROR HANDLER ERROR:", error)
            })
          },
        )

        console.log("USB SCREEN INITIALIZED:", {
          deviceId: id,

          trusted: Boolean(trustedPc),
        })

        setTimeout(() => {
          if (mountedRef.current) {
            connectUsb()
          }
        }, 300)
      } catch (error) {
        console.log("USB SCREEN INITIALIZE ERROR:", error)

        setUsbStatus("error")

        setUsbError(error?.message || "حدث خطأ أثناء تشغيل USB.")
      }
    }

    initialize()

    return () => {
      mountedRef.current = false

      try {
        messageSubscription?.remove?.()
      } catch (_) {}

      try {
        stateSubscription?.remove?.()
      } catch (_) {}

      try {
        errorSubscription?.remove?.()
      } catch (_) {}

      try {
        fileProgressSubscription?.remove?.()
      } catch (_) {}

      try {
        fileCompletedSubscription?.remove?.()
      } catch (_) {}

      try {
        fileErrorSubscription?.remove?.()
      } catch (_) {}
    }
  }, [
    connectUsb,
    findRequestIdByTransferId,
    handleConnectionError,
    handleConnectionState,
    handleIncomingFileError,
    handleMessage,
    loadDeviceId,
    loadTrustedUsb,
    verifyIncomingFile,
  ])

  // ==========================================================
  // START DATABASE SYNC AFTER CONNECT
  // ==========================================================

  useEffect(() => {
    if (!usbConnected) {
      return
    }

    if (!trusted) {
      return
    }

    if (databaseSyncRunningRef.current) {
      return
    }

    const timer = setTimeout(() => {
      startDatabaseSync()
    }, 600)

    const casedb = setTimeout(() => {
      startCaseFilesSync()
    }, 600)

    return () => {
      clearTimeout(timer)
      clearTimeout(casedb)
    }
  }, [usbConnected, trusted, startDatabaseSync])

  // ==========================================================
  // START FILE AUTO SYNC
  //
  // يتم استدعاؤه بعد DATABASE_SYNC_COMPLETE.
  // يوجد أيضًا حماية داخلية لمنع التكرار.
  // ==========================================================

  // useEffect(() => {
  //   syncDatabaseFilesRef.current = syncDatabaseFiles
  // }, [syncDatabaseFiles])

  // ==========================================================
  // CLEANUP
  // ==========================================================

  useEffect(() => {
    return () => {
      mountedRef.current = false

      autoSyncStartedRef.current = false

      autoSyncCurrentRef.current = null

      for (const [requestId, waiter] of autoSyncWaitersRef.current) {
        try {
          waiter.reject(new Error("CONNECTION_CLOSED"))
        } catch (_) {}
      }

      autoSyncWaitersRef.current.clear()

      databaseSyncRunningRef.current = false

      databaseSyncRequestRef.current = null
    }
  }, [])

  // ==========================================================
  // UI
  // ==========================================================

  const statusText = !usbConnected
    ? usbStatus === "offline"
      ? "تعذر الاتصال بالكمبيوتر"
      : usbStatus === "connecting"
        ? "جاري الاتصال عبر USB..."
        : "غير متصل"
    : pairingState === "requesting"
      ? "جارٍ إنشاء طلب الاقتران..."
      : pairingState === "code_received"
        ? "أدخل كود الاقتران"
        : pairingState === "confirming"
          ? "جارٍ التحقق من كود الاقتران..."
          : trusted
            ? "متصل وموثوق"
            : "متصل عبر USB"

  const statusColor = !usbConnected
    ? usbStatus === "offline"
      ? "#dc2626"
      : "#64748b"
    : pairingState === "code_received"
      ? "#ca8a04"
      : pairingState === "confirming"
        ? "#2563eb"
        : trusted
          ? "#16a34a"
          : "#2563eb"

  const getProgress = transfer => {
    const total = Number(transfer?.total || 0)

    const transferred = Number(transfer?.transferred || 0)

    if (total <= 0) {
      return 0
    }

    return Math.min(100, Math.max(0, Math.round((transferred / total) * 100)))
  }

  const formatBytes = bytes => {
    if (!bytes || bytes <= 0) {
      return "0 B"
    }

    const units = ["B", "KB", "MB", "GB", "TB"]

    const index = Math.floor(Math.log(bytes) / Math.log(1024))

    const safeIndex = Math.min(index, units.length - 1)

    return `${(bytes / Math.pow(1024, safeIndex)).toFixed(
      safeIndex === 0 ? 0 : 1,
    )} ${units[safeIndex]}`
  }

  function isSafeCaseFileRelativePath(value) {
    if (!value) {
      return false
    }

    const normalized = normalizeRelativePath(value)

    if (!normalized) {
      return false
    }

    const parts = normalized.split("/")

    if (parts.length !== 2) {
      return false
    }

    if (!parts[0] || !parts[1]) {
      return false
    }

    if (
      parts[0] === "." ||
      parts[0] === ".." ||
      parts[1] === "." ||
      parts[1] === ".."
    ) {
      return false
    }

    return true
  }

  function extractCaseFileEntityId(relativePath) {
    const normalized = normalizeRelativePath(relativePath)

    if (!isSafeCaseFileRelativePath(normalized)) {
      return null
    }

    return normalized.split("/")[0]
  }

  function extractCaseFileName(relativePath) {
    const normalized = normalizeRelativePath(relativePath)

    if (!isSafeCaseFileRelativePath(normalized)) {
      return null
    }

    return normalized.split("/")[1]
  }

  const buildCaseFilesManifest = useCallback(async () => {
    const root = `${FileSystem.documentDirectory}documents/`

    const files = []

    const rootInfo = await getFileInfoSafe(root)

    if (!rootInfo?.exists) {
      return {
        generatedAt: new Date().toISOString(),
        total: 0,
        files: [],
      }
    }

    /*
     * نحتاج قراءة مجلد documents.
     *
     * FileSystem.readDirectoryAsync يعطي أسماء
     * المجلدات والملفات.
     */
    const entityIds = await FileSystem.readDirectoryAsync(root)

    for (const entityId of entityIds) {
      const safeEntityId = sanitizePathPart(entityId, "")

      if (!safeEntityId) {
        continue
      }

      const entityDirectory = `${root}${safeEntityId}/`

      const entityInfo = await getFileInfoSafe(entityDirectory)

      if (!entityInfo?.exists || entityInfo.isDirectory !== true) {
        continue
      }

      const names = await FileSystem.readDirectoryAsync(entityDirectory)

      for (const fileName of names) {
        const safeFileName = sanitizePathPart(fileName, "")

        if (!safeFileName) {
          continue
        }

        const relativePath = `${safeEntityId}/${safeFileName}`

        if (!isSafeCaseFileRelativePath(relativePath)) {
          continue
        }

        const uri = `${entityDirectory}${safeFileName}`

        const info = await getFileInfoSafe(uri)

        if (!info?.exists || info.isDirectory === true) {
          continue
        }

        files.push({
          relativePath,

          entityId: safeEntityId,

          fileName: safeFileName,

          size: Number(info.size || 0),

          sha256: null,

          mimeType: "application/octet-stream",
        })
      }
    }

    return {
      generatedAt: new Date().toISOString(),

      total: files.length,

      files,
    }
  }, [])

  const startCaseFilesSync = useCallback(async () => {
    if (!connectedRef.current) {
      console.log("USB CASE FILES SYNC SKIPPED: NO CONNECTION")

      return
    }

    if (!trustedRef.current) {
      console.log("USB CASE FILES SYNC SKIPPED: NOT TRUSTED")

      return
    }

    if (caseFilesSyncRunningRef.current) {
      console.log("USB CASE FILES SYNC SKIPPED: ALREADY RUNNING")

      return
    }

    caseFilesSyncRunningRef.current = true

    const generation = ++caseFilesSyncGenerationRef.current

    const requestId = createRequestId()

    try {
      const manifest = await buildCaseFilesManifest()

      if (generation !== caseFilesSyncGenerationRef.current) {
        caseFilesSyncRunningRef.current = false
        return
      }

      caseFilesSyncRequestRef.current = {
        requestId,
        startedAt: Date.now(),
      }

      console.log("========================================")

      console.log("USB CASE FILES SYNC REQUEST:", {
        requestId,
        total: manifest.total,
      })

      console.log("========================================")

      const success = send({
        type: "CASE_FILES_SYNC_REQUEST",

        version: 1,

        requestId,

        timestamp: Date.now(),

        payload: {
          requestId,

          manifest,

          transport: "usb",
        },
      })

      if (!success) {
        throw new Error("CASE_FILES_SYNC_REQUEST_SEND_FAILED")
      }
    } catch (error) {
      console.error("USB CASE FILES SYNC START ERROR:", error)

      caseFilesSyncRequestRef.current = null

      caseFilesSyncRunningRef.current = false

      setUsbError(error?.message || "فشل بدء مزامنة ملفات القضايا.")
    }
  }, [buildCaseFilesManifest, send])

  const handleCaseFilesUploadRequests = useCallback(
    async requests => {
      if (!Array.isArray(requests) || requests.length === 0) {
        console.log("USB CASE FILES UPLOAD REQUESTS: EMPTY")

        return
      }

      for (const request of requests) {
        try {
          const relativePath = normalizeRelativePath(request?.relativePath)

          if (!isSafeCaseFileRelativePath(relativePath)) {
            console.error(
              "USB CASE FILE REQUEST: INVALID RELATIVE PATH",
              request,
            )

            continue
          }

          const pathEntityId = extractCaseFileEntityId(relativePath)

          const fileName = extractCaseFileName(relativePath)

          const entityId = request?.entityId || pathEntityId

          if (String(entityId) !== String(pathEntityId)) {
            console.error("USB CASE FILE REQUEST: ENTITY ID MISMATCH", {
              entityId,
              pathEntityId,
              relativePath,
            })

            continue
          }

          const fileUri = `${FileSystem.documentDirectory}documents/${pathEntityId}/${fileName}`

          const info = await getFileInfoSafe(fileUri)

          if (!info?.exists || info.isDirectory === true) {
            console.error("USB CASE FILE REQUEST: FILE NOT FOUND", {
              relativePath,
              fileUri,
            })

            continue
          }

          const fileSize = Number(info.size || 0)

          const requestId = createRequestId()

          const pendingFile = {
            requestId,

            transferId: null,

            uri: fileUri,

            name: fileName,

            fileName,

            size: fileSize,

            mimeType: request?.mimeType || "application/octet-stream",

            relativePath,

            entityType: request?.entityType || "case",

            entityId: pathEntityId,

            syncFileId: null,

            caseFileSync: true,

            databaseFile: false,

            direction: "ANDROID_TO_PC",
          }

          caseFilesPendingUploadsRef.current.set(requestId, pendingFile)

          pendingFilesRef.current.set(requestId, pendingFile)

          setTransfers(previous => [
            ...previous,

            {
              id: requestId,

              requestId,

              transferId: null,

              fileName,

              total: fileSize,

              transferred: 0,

              progress: 0,

              status: "waiting",

              direction: "ANDROID_TO_PC",

              relativePath,

              entityType: pendingFile.entityType,

              entityId: pathEntityId,

              caseFileSync: true,
            },
          ])

          console.log("========================================")

          console.log("USB CASE FILE UPLOAD REQUEST PREPARED:", {
            requestId,

            fileName,

            fileSize,

            fileUri,

            relativePath,

            entityId: pathEntityId,
          })

          console.log("========================================")

          const success = send({
            type: "FILE_REQUEST",

            version: 1,

            requestId,

            timestamp: Date.now(),

            payload: {
              requestId,

              fileName,

              fileSize,

              mimeType: pendingFile.mimeType,

              relativePath,

              entityType: pendingFile.entityType,

              entityId: pathEntityId,

              caseFileSync: true,
            },
          })

          if (!success) {
            throw new Error("CASE_FILE_FILE_REQUEST_SEND_FAILED")
          }

          console.log("USB CASE FILE FILE_REQUEST SENT:", {
            requestId,

            relativePath,

            entityId: pathEntityId,
          })
        } catch (error) {
          console.error("USB CASE FILE UPLOAD REQUEST ERROR:", {
            request,
            error: error?.message || String(error),
          })
        }
      }
    },
    [send],
  )

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0f172a" }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 5}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        {/* ================================================== */}
        {/* HEADER */}
        {/* ================================================== */}

        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <MaterialIcons name="usb" size={32} color="#818cf8" />
          </View>

          <View style={styles.headerText}>
            <Text style={styles.title}>مزامنة USB</Text>

            <Text style={styles.subtitle}>
              مزامنة بيانات الأفوكاتو مباشرة عبر USB
            </Text>
          </View>
        </View>

        {/* ================================================== */}
        {/* CONNECTION */}
        {/* ================================================== */}

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>حالة الاتصال</Text>

            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor: usbConnected ? "#2c3e50" : "#34495e",
                },
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: statusColor,
                  },
                ]}
              />

              <Text style={styles.statusText}>{statusText}</Text>
            </View>
          </View>

          {pcDevice ? (
            <View style={styles.connectedBox}>
              <View style={styles.deviceIcon}>
                <MaterialIcons name="computer" size={32} color="#818cf8" />
              </View>

              <View style={styles.deviceInfo}>
                <Text style={styles.deviceName}>{pcDevice.name}</Text>

                <Text style={styles.deviceIp}>USB / ADB Reverse</Text>

                <Text style={styles.deviceIp}>
                  WS: {USB_WS_PORT}
                  {"  "}
                  HTTP: {USB_HTTP_PORT}
                </Text>

                <Text style={styles.trustedText}>
                  {trusted ? "✓ جهاز موثوق" : "⚠ يحتاج إلى اقتران"}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.notConnected}>
              <MaterialIcons name="usb" size={42} color="#64748b" />

              <Text style={styles.notConnectedText}>
                {usbStatus === "connecting"
                  ? "جاري الاتصال عبر USB..."
                  : "لم يتم الاتصال بالكمبيوتر"}
              </Text>
            </View>
          )}

          {usbError ? (
            <View style={styles.errorBox}>
              <MaterialIcons name="error-outline" size={22} color="#f87171" />

              <Text style={styles.errorText}>{usbError}</Text>
            </View>
          ) : null}

          {!usbConnected ? (
            <Pressable
              style={styles.primaryButton}
              onPress={connectUsb}
              // disabled={usbStatus === "connecting"}
            >
              {usbStatus === "connecting" ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="usb" size={22} color="#fff" />
              )}

              <Text style={styles.primaryButtonText}>
                {usbStatus === "connecting"
                  ? "جاري الاتصال..."
                  : "الاتصال عبر USB"}
              </Text>
            </Pressable>
          ) : (
            <View style={{
    flexDirection: "row",

    alignItems: "center",

    gap: 8,
  }}>
             
              {trusted ? (
                <Pressable
                  style={styles.unpairButton}
                  onPress={unpair}
                  className="mt-3"
                >
                  <MaterialIcons
                    name="delete-outline"
                    size={22}
                    color="#f87171"
                  />

                  <Text style={styles.unpairText}>إلغاء الاقتران</Text>
                </Pressable>
              ) : (<Pressable style={styles.primaryButton}  onPress={sendPairRequest} >
                <MaterialIcons name="link" size={22} color="#fff" />

                <Text style={styles.primaryButtonText}>طلب الاقتران</Text>
              </Pressable>)}
               <Pressable
                style={styles.disconnectButton}
                onPress={disconnectUsb}
              >
                <MaterialIcons name="link-off" size={21} color="#fff" />

                <Text style={styles.forgetButtonText}>قطع الاتصال</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* ================================================== */}
        {/* PAIRING */}
        {/* ================================================== */}

        {usbConnected && !trusted ? (
          <View >
            {/* <Text style={styles.cardTitle}>الاقتران</Text>

            <Text style={styles.description}>
              يجب إقران الهاتف بالكمبيوتر قبل بدء المزامنة.
            </Text> */}

            {pairingState === "code_received" && (
              <View>
                <Text style={styles.label}>كود الاقتران</Text>

                <TextInput
                  value={pairingCode}
                  onChangeText={text => {
                    setPairingCode(text.replace(/[^0-9]/g, "").slice(0, 6))
                  }}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="000000"
                  placeholderTextColor="#64748b"
                  textAlign="center"
                  style={styles.codeInput}
                />

                <Text style={styles.hint}>
                  أدخل الكود الظاهر على الكمبيوتر.
                </Text>

                <Pressable
                  style={styles.successButton}
                  onPress={confirmPairing}
                >
                  <MaterialIcons name="check-circle" size={22} color="#fff" />

                  <Text style={styles.primaryButtonText}>تأكيد الاقتران</Text>
                </Pressable>
              </View>
            ) }
          </View>
        ) : null}

        {/* ================================================== */}
        {/* DATABASE SUCCESS */}
        {/* ================================================== */}

        {databaseSyncSuccess ? (
          <View style={styles.successBox}>
            <MaterialIcons name="check-circle" size={24} color="#34d399" />

            <Text style={styles.successText}>
              تمت مزامنة قاعدة البيانات بنجاح
            </Text>
          </View>
        ) : null}
      
{caseFilesSyncSuccess ? (
  <View style={styles.successBox}>
    <MaterialIcons
      name="check-circle"
      size={24}
      color="#16a34a"
    />

    <Text style={styles.successText}>
      تمت مزامنة ملفات القضايا بنجاح
    </Text>
  </View>
) : null}


        {/* ================================================== */}
        {/* FILES */}
        {/* ================================================== */}

        {usbConnected && trusted ? (
          transfers.length > 0 ? (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>نقل الملفات</Text>

                <MaterialIcons name="folder" size={23} color="#818cf8" />
              </View>

              <Text style={styles.description}>
                {fileSyncing
                  ? "جاري مزامنة الملفات الموجودة في sync_files..."
                  : "يتم مزامنة الملفات المعلقة تلقائيًا عبر USB."}
              </Text>

              <View style={styles.transferList}>
                {transfers
                  .slice()
                  .reverse()
                  .map(transfer => {
                    const progress = getProgress(transfer)

                    const isIncoming = transfer.direction === "PC_TO_ANDROID"

                    return (
                      <View
                        key={transfer.requestId}
                        style={styles.transferItem}
                      >
                        <View style={styles.transferTop}>
                          <MaterialIcons
                            name={
                              transfer.status === "completed"
                                ? "check-circle"
                                : transfer.status === "error"
                                  ? "error"
                                  : isIncoming
                                    ? "download"
                                    : "insert-drive-file"
                            }
                            size={23}
                            color={
                              transfer.status === "completed"
                                ? "#34d399"
                                : transfer.status === "error"
                                  ? "#f87171"
                                  : "#818cf8"
                            }
                          />

                          <View style={styles.transferInfo}>
                            <Text numberOfLines={1} style={styles.transferName}>
                              {transfer.fileName}
                            </Text>

                            <Text style={styles.transferSize}>
                              {formatBytes(transfer.transferred)}
                              {" / "}
                              {formatBytes(transfer.total)}
                            </Text>
                          </View>

                          <Text style={styles.progressText}>{progress}%</Text>
                        </View>

                        <View style={styles.progressBackground}>
                          <View
                            style={[
                              styles.progressBar,
                              {
                                width: `${progress}%`,
                              },
                            ]}
                          />
                        </View>

                        <Text style={styles.transferStatus}>
                          {transfer.status === "waiting"
                            ? "في انتظار البدء..."
                            : transfer.status === "transferring"
                              ? "جاري النقل..."
                              : transfer.status === "completed"
                                ? isIncoming
                                  ? "تم تنزيل الملف إلى الهاتف بنجاح"
                                  : "تم النقل بنجاح وحذف مهمة المزامنة"
                                : "فشل النقل"}
                        </Text>

                        {transfer.syncFileId ? (
                          <Text style={styles.syncFileIdText}>
                            syncFileId: {transfer.syncFileId}
                          </Text>
                        ) : null}
                      </View>
                    )
                  })}
              </View>
            </View>
          ) : null
        ) : null}

        {/* ================================================== */}
        {/* HOW IT WORKS */}
        {/* ================================================== */}
        {!usbConnected && (
          <View className="mt-5 rounded-3xl bg-slate-800 border border-slate-700 p-5 shadow-sm">
            <Text className="text-lg font-black text-slate-100">
              طريقة الاستخدام
            </Text>

            <View className="mt-5">
              <Step
                number="1"
                icon="cable"
                title="وصل كابل USB"
                description="قم بتوصيل الهاتف بالكمبيوتر."
              />

              <Step
                number="2"
                icon="usb"
                title="تشغيل Avocato Desktop"
                description="يقوم Avocato Desktop بتشغيل ADB المدمج وإنشاء قناة USB."
              />

              <Step
                number="3"
                icon="login"
                title="طلب الاقتران"
                description="بعد الاتصال يرسل الهاتف طلب الاقتران إلى الكمبيوتر."
              />

              <Step
                number="4"
                icon="computer"
                title="عرض الكود على الكمبيوتر"
                description="يظهر كود الاقتران المكون من 6 أرقام على شاشة Sync في الكمبيوتر."
              />

              <Step
                number="5"
                icon="vpn-key"
                title="إدخال الكود على الهاتف"
                description="اكتب الكود الظاهر على الكمبيوتر في الحقل الموجود على الهاتف."
              />

              <Step
                number="6"
                icon="check-circle"
                title="تأكيد الاقتران"
                description="اضغط تأكيد الاقتران، وبعد التحقق يصبح الكمبيوتر موثوقًا."
              />

              <Step
                number="7"
                icon="sync"
                title="المزامنة"
                description="بعد نجاح الاقتران يمكن تشغيل مزامنة قاعدة البيانات ونقل الملفات."
              />
            </View>
          </View>
        )}

        {/* ================================================== */}
        {/* INFO */}
        {/* ================================================== */}

        <View style={styles.infoBox} className="mt-4">
          <MaterialIcons name="info-outline" size={22} color="#818cf8" />

          <Text style={styles.infoText}>
            اتصال USB يستخدم ADB Reverse - تأكد من أن كابل الـ USB يدعم نقل
            البيانات .
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Step({ number, icon, title, description }) {
  return (
    <View className="mb-5 flex-row">
      <View className="items-center">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-indigo-600">
          <Text className="text-sm font-black text-white">{number}</Text>
        </View>
      </View>

      <View className="ml-3 flex-1">
        <View className="flex-row items-center">
          <MaterialIcons name={icon} size={20} color="#818cf8" />

          <Text className="ml-2 text-base font-bold text-slate-100">
            {title}
          </Text>
        </View>

        <Text className="mt-1 text-sm leading-6 text-slate-400">
          {description}
        </Text>
      </View>
    </View>
  )
}

// ============================================================
// STYLES (Dark Mode)
// ============================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },

  content: {
    padding: 16,
    paddingBottom: 40,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
  },

  headerIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: "#312e81",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },

  headerText: {
    flex: 1,
  },

  title: {
    fontSize: 25,
    fontWeight: "800",
    color: "#f1f5f9",
  },

  subtitle: {
    marginTop: 3,
    fontSize: 14,
    color: "#94a3b8",
  },

  card: {
    backgroundColor: "#1e293b",
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#334155",
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.2,
    shadowRadius: 5,
    elevation: 2,
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },

  cardTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#f1f5f9",
  },

  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 5,
    paddingVertical: 6,
    borderRadius: 20,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },

  statusText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#cbd5e1",
  },

  connectedBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#334155",
  },

  deviceIcon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: "#312e81",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },

  deviceInfo: {
    flex: 1,
  },

  deviceName: {
    fontSize: 17,
    fontWeight: "800",
    color: "#f1f5f9",
  },

  deviceIp: {
    marginTop: 3,
    fontSize: 12,
    color: "#94a3b8",
  },

  trustedText: {
    marginTop: 5,
    fontSize: 13,
    color: "#34d399",
    fontWeight: "700",
  },

  notConnected: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
  },

  notConnectedText: {
    marginTop: 10,
    fontSize: 14,
    color: "#94a3b8",
    textAlign: "center",
  },

  description: {
    marginTop: 5,
    marginBottom: 15,
    fontSize: 13,
    lineHeight: 21,
    color: "#94a3b8",
  },

  label: {
    marginBottom: 8,
    fontSize: 13,
    fontWeight: "700",
    color: "#cbd5e1",
  },

  codeInput: {
    height: 58,
    borderWidth: 2,
    borderColor: "#4338ca",
    borderRadius: 14,
    backgroundColor: "#0f172a",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 6,
    color: "#f1f5f9",
    marginBottom: 8,
  },

  hint: {
    fontSize: 12,
    color: "#94a3b8",
    textAlign: "center",
    marginBottom: 14,
  },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#451a03",
    borderWidth: 1,
    borderColor: "#78350f",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },

  errorText: {
    flex: 1,
    marginLeft: 8,
    color: "#fca5a5",
    fontSize: 13,
    lineHeight: 20,
  },

  successBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#064e3b",
    borderWidth: 1,
    borderColor: "#047857",
    borderRadius: 13,
    padding: 13,
    marginBottom: 12,
  },

  successText: {
    flex: 1,
    marginLeft: 8,
    fontSize: 13,
    fontWeight: "700",
    color: "#d1fae5",
  },

  databaseStatusRow: {
    flexDirection: "row",
    alignItems: "center",
  },

  databaseStatusText: {
    fontSize: 13,
    color: "#94a3b8",
    fontWeight: "600",
  },

  primaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: "#4f46e5",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    gap: 8,
  },

  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },

  successButton: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: "#16a34a",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },

  disconnectButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: "#991b1b",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },

  forgetButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },

  progressBackground: {
    height: 8,
    backgroundColor: "#334155",
    borderRadius: 10,
    overflow: "hidden",
    marginTop: 10,
  },

  progressBar: {
    height: "100%",
    backgroundColor: "#4f46e5",
    borderRadius: 10,
  },

  transferList: {
    marginTop: 14,
  },

  transferItem: {
    backgroundColor: "#0f172a",
    borderRadius: 13,
    padding: 12,
    marginTop: 9,
    borderWidth: 1,
    borderColor: "#334155",
  },

  transferTop: {
    flexDirection: "row",
    alignItems: "center",
  },

  transferInfo: {
    flex: 1,
    marginHorizontal: 9,
  },

  transferName: {
    fontSize: 14,
    fontWeight: "700",
    color: "#f1f5f9",
  },

  transferSize: {
    marginTop: 3,
    fontSize: 11,
    color: "#94a3b8",
  },

  progressText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#818cf8",
  },

  transferStatus: {
    marginTop: 6,
    fontSize: 11,
    color: "#94a3b8",
  },

  syncFileIdText: {
    marginTop: 5,
    fontSize: 10,
    color: "#64748b",
  },

  unpairButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: "#450a0a",
    borderWidth: 1,
    borderColor: "#7f1d1d",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
    gap: 7,
  },

  unpairText: {
    color: "#f87171",
    fontSize: 14,
    fontWeight: "800",
  },

  infoBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 13,
    padding: 13,
    marginBottom: 12,
  },

  infoText: {
    flex: 1,
    marginLeft: 8,
    fontSize: 12,
    lineHeight: 19,
    color: "#94a3b8",
  },
})
