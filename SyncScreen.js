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

import {
  createDatabaseSyncPayload,
  applyChanges,
  setLastSyncAt,
  getChangesCount,
} from "../utils/databaseSync"

import * as Crypto from "expo-crypto"
import AsyncStorage from "@react-native-async-storage/async-storage"
import * as DocumentPicker from "expo-document-picker"
import * as FileSystem from "expo-file-system/legacy"

import { MaterialIcons } from "@react-native-vector-icons/material-icons"

import { useSQLiteContext } from "expo-sqlite"
import { eq } from "drizzle-orm"

import AvocatoFlow from "../modules/avocato-flow/src"

import * as schema from "../db/schema"
import { drizzle } from "drizzle-orm/expo-sqlite"

const TRUSTED_PC_KEY = "@avocato_flow_trusted_pc"

const DEFAULT_WEBSOCKET_PORT = 47822
const DEFAULT_HTTP_PORT = 47823

const DISCOVERY_TIMEOUT = 30 * 1000
const DISCOVERY_RETRY_DELAY = 2000

const RECEIVED_FILES_DIRECTORY = "Avocato/Received"

/* ============================================================
 * PATH HELPERS
 * ============================================================ */

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

function sanitizeRelativePath(value) {
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

/* ============================================================
 * SCREEN
 * ============================================================ */

export default function SyncScreen() {
  const database = useSQLiteContext()

  const db = useMemo(() => drizzle(database, { schema }), [database])

  /* ============================================================
   * UI STATE
   * ============================================================ */

  const [pairConfirmVisible, setPairConfirmVisible] = useState(false)
  const [databaseSyncSuccess, setDatabaseSyncSuccess] = useState(false)

  const [pairCodeInput, setPairCodeInput] = useState("")

  const [pairRequest, setPairRequest] = useState(null)

  const [devices, setDevices] = useState([])

  const [connectedDevice, setConnectedDevice] = useState(null)

  const [isTrusted, setIsTrusted] = useState(false)

  const [connectingId, setConnectingId] = useState(null)

  const [autoConnecting, setAutoConnecting] = useState(false)

  const [connectionError, setConnectionError] = useState(null)

  const [isDiscovering, setIsDiscovering] = useState(false)

  const [isSendingTest, setIsSendingTest] = useState(false)

  const [transfers, setTransfers] = useState([])

  const [trustedPc, setTrustedPc] = useState(null)

  const [databaseSyncing, setDatabaseSyncing] = useState(false)

  /* ============================================================
   * DATABASE SYNC REFS
   * ============================================================ */

  const databaseSyncRequestRef = useRef(null)

  const databaseSyncRunningRef = useRef(false)

  const databaseAutoSyncStartedRef = useRef(false)

  /* ============================================================
   * CONNECTION / DISCOVERY REFS
   * ============================================================ */

  const autoConnectAttemptRef = useRef(false)

  const connectedDeviceRef = useRef(null)

  const discoveryTimerRef = useRef(null)

  const discoveryRestartTimerRef = useRef(null)

  const manualDiscoveryStopRef = useRef(false)

  const manualDisconnectRef = useRef(false)

  const pendingFilesRef = useRef(new Map())

  const notifiedTransfersRef = useRef(new Set())

  const connectionGenerationRef = useRef(0)
  const disconnectGenerationRef = useRef(0)

  /* ============================================================
   * FILE AUTO SYNC REFS
   * ============================================================ */

  const autoSyncStartedRef = useRef(false)

  const autoSyncFilesRef = useRef(new Set())

  const autoSyncQueueRef = useRef([])

  const autoSyncCurrentRef = useRef(null)

  const autoSyncWaitersRef = useRef(new Map())

  const syncDatabaseFilesRef = useRef(null)

  /* ============================================================
   * PC -> ANDROID DOWNLOADS
   *
   * transferId -> native download state
   * ============================================================ */

  const incomingDownloadsRef = useRef(new Map())
  const reconnectTimerRef = useRef(null)
  const reconnectAttemptRef = useRef(0)
  const disconnectHandledRef = useRef(false)

  /* ============================================================
   * LOAD TRUSTED PC
   * ============================================================ */

  useEffect(() => {
    let mounted = true

    const loadTrustedPc = async () => {
      try {
        const value = await AsyncStorage.getItem(TRUSTED_PC_KEY)

        if (!value) {
          return
        }

        const device = JSON.parse(value)

        if (!device?.id) {
          await AsyncStorage.removeItem(TRUSTED_PC_KEY)

          return
        }

        if (mounted) {
          setTrustedPc(device)
          setIsTrusted(false)
        }
      } catch (error) {
        console.error("LOAD TRUSTED PC ERROR:", error)
      }
    }

    loadTrustedPc()

    return () => {
      mounted = false
    }
  }, [])

  /* ============================================================
   * DISCOVERY HELPERS
   * ============================================================ */

  const clearDiscoveryTimer = useCallback(() => {
    if (discoveryTimerRef.current) {
      clearTimeout(discoveryTimerRef.current)

      discoveryTimerRef.current = null
    }
  }, [])

  const clearDiscoveryRestartTimer = useCallback(() => {
    if (discoveryRestartTimerRef.current) {
      clearTimeout(discoveryRestartTimerRef.current)

      discoveryRestartTimerRef.current = null
    }
  }, [])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  /* ============================================================
   * FILE TRANSFER HELPERS
   * ============================================================ */

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

  const updateTransfer = useCallback((requestId, patch) => {
    if (!requestId) {
      return
    }

    setTransfers(prev =>
      prev.map(item =>
        item.requestId === requestId
          ? {
              ...item,
              ...patch,
            }
          : item,
      ),
    )
  }, [])

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

  /* ============================================================
   * PC -> ANDROID STORAGE
   * ============================================================ */

  const ensureReceivedDirectory = useCallback(
    async (relativePath, entityId = null) => {
      const baseDirectory = FileSystem.documentDirectory

      if (!baseDirectory) {
        throw new Error("ANDROID_DOCUMENT_DIRECTORY_NOT_AVAILABLE")
      }

      /*
       * Android storage structure:
       *
       * files/
       *   documents/
       *     <entityId>/
       *       <fileName>
       *
       * We intentionally DO NOT use the PC relativePath
       * as the root directory because the PC may send:
       *
       * avocato\files\<entityId>\<fileName>
       *
       * which is a Windows-side path.
       */

      let currentDirectory = `${baseDirectory}documents/`

      /*
       * Ensure:
       *
       * files/documents/
       */

      const rootInfo = await FileSystem.getInfoAsync(currentDirectory)

      if (!rootInfo.exists) {
        await FileSystem.makeDirectoryAsync(currentDirectory, {
          intermediates: true,
        })
      }

      /*
       * If entityId is available, use it directly.
       */

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

      /*
       * Fallback:
       *
       * If entityId is not supplied, use relativePath
       * but remove the old Windows root:
       *
       * avocato/files/
       */

      let safeRelativePath = sanitizeRelativePath(relativePath)

      safeRelativePath = safeRelativePath
        .replace(/^avocato[\\/]+files[\\/]+/i, "")
        .replace(/^documents[\\/]+/i, "")

      const parts = safeRelativePath
        ? safeRelativePath.split(/[\\/]+/).filter(Boolean)
        : []

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

  const getIncomingFileDestination = useCallback(
    async ({ fileName, relativePath, entityType, entityId }) => {
      const safeFileName = sanitizePathPart(
        fileName || "received-file",
        "received-file",
      )

      const safeRelative = sanitizeRelativePath(relativePath)

      let destinationDirectory

      if (safeRelative) {
        destinationDirectory = await ensureReceivedDirectory(safeRelative)
      } else {
        destinationDirectory = await ensureReceivedDirectory(null)
      }

      let finalName = safeFileName

      if (safeRelative) {
        const relativeParts = safeRelative.split("/").filter(Boolean)

        if (relativeParts.length > 0) {
          finalName = sanitizePathPart(
            relativeParts[relativeParts.length - 1],
            safeFileName,
          )
        }
      }

      /*
       * Metadata محفوظ في pendingFiles.
       *
       * لا نستخدم entityType/entityId
       * لتغيير المسار هنا حتى لا نكسر
       * نظام ملفات القضايا الحالي.
       */

      void entityType
      void entityId

      return `${destinationDirectory}${finalName}`
    },
    [ensureReceivedDirectory],
  )

  /* ============================================================
   * PC -> ANDROID:
   * FILE_SEND_ACCEPT
   * ============================================================ */

  const sendFileSendAccept = useCallback(
    ({ requestId, transferId, startByte = 0, fileName }) => {
      try {
        AvocatoFlow.sendMessage(
          JSON.stringify({
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
            },
          }),
        )

        console.log("FILE_SEND_ACCEPT SENT:", {
          requestId,
          transferId,
          startByte,
        })
      } catch (error) {
        console.error("FILE_SEND_ACCEPT ERROR:", error)

        throw error
      }
    },
    [],
  )

  /* ============================================================
   * PC -> ANDROID DOWNLOAD
   *
   * IMPORTANT:
   *
   * This function uses:
   *
   * AvocatoFlow.downloadFile()
   *
   * and NOT:
   *
   * FileSystem.createDownloadResumable()
   *
   * ============================================================ */

  const downloadIncomingFile = useCallback(
    async ({
      requestId,
      transferId,
      fileName,
      fileSize,
      mimeType,
      relativePath,
      entityType,
      entityId,
      syncFileId,
    }) => {
      if (!requestId) {
        throw new Error("REQUEST_ID_MISSING")
      }

      if (!transferId) {
        throw new Error("TRANSFER_ID_MISSING")
      }

      const pc = connectedDeviceRef.current

      if (!pc?.ip) {
        throw new Error("PC_IP_MISSING")
      }

      if (!isTrusted) {
        throw new Error("DEVICE_NOT_TRUSTED")
      }

      const normalizedSize = Number(fileSize || 0)

      if (!Number.isFinite(normalizedSize) || normalizedSize < 0) {
        throw new Error("INVALID_FILE_SIZE")
      }

      const httpPort = Number(pc.httpPort || DEFAULT_HTTP_PORT)

      const downloadUrl =
        `http://${pc.ip}:${httpPort}/transfer/` +
        encodeURIComponent(String(transferId))

      const destinationUri = await getIncomingFileDestination({
        fileName,
        relativePath,
        entityType,
        entityId,
      })

      console.log("========================================")

      console.log("PC -> ANDROID DOWNLOAD")

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
        downloadUrl,
        destinationUri,
      })

      console.log("========================================")

      /* --------------------------------------------------------
       * Existing file / Resume
       * -------------------------------------------------------- */

      let existingInfo = null

      try {
        existingInfo = await FileSystem.getInfoAsync(destinationUri)
      } catch (error) {
        console.log("DESTINATION INFO ERROR:", error)
      }

      let startByte = 0

      if (existingInfo?.exists && existingInfo?.isDirectory !== true) {
        const existingSize = Number(existingInfo.size || 0)

        /*
         * الملف مكتمل بالفعل.
         */
        if (normalizedSize > 0 && existingSize === normalizedSize) {
          pendingFilesRef.current.set(requestId, {
            requestId,
            transferId,

            uri: destinationUri,

            name: fileName || "File",

            fileName: fileName || "File",

            size: normalizedSize,

            mimeType: mimeType || "application/octet-stream",

            relativePath: relativePath || fileName || "file",

            entityType: entityType || null,

            entityId: entityId || null,

            syncFileId: syncFileId || null,

            direction: "PC_TO_ANDROID",

            /*
             * مهم جدًا.
             *
             * لا تجعلها true.
             */
            databaseFile: false,

            receivedFile: true,

            destinationUri,
          })

          updateTransfer(requestId, {
            id: requestId,

            requestId,

            transferId,

            fileName: fileName || "File",

            total: normalizedSize,

            transferred: normalizedSize,

            progress: 1,

            status: "completed",

            direction: "PC_TO_ANDROID",

            uri: destinationUri,
          })

          try {
            AvocatoFlow.sendMessage(
              JSON.stringify({
                type: "FILE_COMPLETE",

                version: 1,

                requestId,
                transferId,

                timestamp: Date.now(),

                payload: {
                  requestId,
                  transferId,

                  fileName: fileName || "File",

                  fileSize: normalizedSize,

                  receivedBytes: normalizedSize,

                  uri: destinationUri,

                  relativePath: relativePath || null,

                  entityType: entityType || null,

                  entityId: entityId || null,

                  syncFileId: syncFileId || null,

                  direction: "PC_TO_ANDROID",
                },
              }),
            )
          } catch (error) {
            console.error("SEND EXISTING FILE_COMPLETE ERROR:", error)
          }

          pendingFilesRef.current.delete(requestId)

          return {
            success: true,

            destinationUri,

            alreadyExists: true,

            size: normalizedSize,
          }
        }

        /*
         * يوجد ملف جزئي.
         *
         * سنستكمل من الحجم الموجود.
         */
        if (
          normalizedSize > 0 &&
          existingSize > 0 &&
          existingSize < normalizedSize
        ) {
          startByte = existingSize

          console.log("RESUMING PC -> ANDROID DOWNLOAD:", {
            transferId,
            existingSize,
            normalizedSize,
            startByte,
          })
        }

        /*
         * إذا كان حجم الملف غير معروف.
         */
        if (normalizedSize === 0 && existingSize > 0) {
          startByte = existingSize
        }
      }

      /* --------------------------------------------------------
       * Pending file
       * -------------------------------------------------------- */

      const pendingFile = {
        requestId,

        transferId,

        uri: destinationUri,

        name: fileName || "File",

        fileName: fileName || "File",

        size: normalizedSize,

        mimeType: mimeType || "application/octet-stream",

        relativePath: relativePath || fileName || "file",

        entityType: entityType || null,

        entityId: entityId || null,

        syncFileId: syncFileId || null,

        direction: "PC_TO_ANDROID",

        /*
         * مهم جدًا:
         *
         * PC -> Android
         * ليس databaseFile.
         */
        databaseFile: false,

        receivedFile: true,

        destinationUri,
      }

      pendingFilesRef.current.set(requestId, pendingFile)

      /* --------------------------------------------------------
       * UI
       * -------------------------------------------------------- */

      setTransfers(prev => {
        const exists = prev.some(item => item.requestId === requestId)

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

          uri: destinationUri,
        }

        if (exists) {
          return prev.map(old =>
            old.requestId === requestId
              ? {
                  ...old,
                  ...item,
                }
              : old,
          )
        }

        return [...prev, item]
      })

      /* --------------------------------------------------------
       * Tell PC Android is ready
       * -------------------------------------------------------- */

      sendFileSendAccept({
        requestId,
        transferId,
        startByte,
        fileName,
      })

      updateTransfer(requestId, {
        status: "transferring",

        transferred: startByte,

        total: normalizedSize,

        progress:
          normalizedSize > 0 ? Math.min(1, startByte / normalizedSize) : 0,
      })

      /* --------------------------------------------------------
       * Native download
       * -------------------------------------------------------- */

      try {
        const result = AvocatoFlow.downloadFile(
          transferId,
          downloadUrl,
          destinationUri,
          startByte,
        )

        console.log("NATIVE PC -> ANDROID DOWNLOAD STARTED:", {
          requestId,
          transferId,
          downloadUrl,
          destinationUri,
          startByte,
          result,
        })
      } catch (error) {
        console.error("NATIVE DOWNLOAD FILE ERROR:", error)

        throw error
      }

      return {
        success: true,

        requestId,

        transferId,

        destinationUri,

        startByte,
      }
    },
    [getIncomingFileDestination, isTrusted, sendFileSendAccept, updateTransfer],
  )

  /* ============================================================
   * CANCEL / PAUSE INCOMING DOWNLOAD
   * ============================================================ */

  const cancelIncomingDownload = useCallback(async transferId => {
    if (!transferId) {
      return
    }

    const download = incomingDownloadsRef.current.get(transferId)

    if (!download) {
      return
    }

    try {
      /*
       * Kept for compatibility with any
       * older download implementation.
       */
      if (typeof download.pauseAsync === "function") {
        await download.pauseAsync()
      }

      console.log("PC -> ANDROID DOWNLOAD PAUSED:", transferId)
    } catch (error) {
      console.error("PAUSE INCOMING DOWNLOAD ERROR:", error)
    }

    incomingDownloadsRef.current.delete(transferId)
  }, [])

  /* ============================================================
   * INCOMING FILE ERROR
   * ============================================================ */

  const handleIncomingFileError = useCallback(
    async ({ requestId, transferId, error }) => {
      const download =
        transferId && incomingDownloadsRef.current.get(transferId)

      if (download) {
        try {
          if (typeof download.pauseAsync === "function") {
            await download.pauseAsync()
          }
        } catch (_) {}

        incomingDownloadsRef.current.delete(transferId)
      }

      const errorMessage =
        error?.message || error || "فشل استقبال الملف من الكمبيوتر."

      console.error("PC -> ANDROID FILE ERROR:", {
        requestId,
        transferId,
        error: errorMessage,
      })

      markTransferError(requestId, String(errorMessage))
    },
    [markTransferError],
  )

  /* ============================================================
   * FILE COMPLETE
   * ============================================================ */

  const markTransferCompleted = useCallback(
    async requestId => {
      if (!requestId) {
        console.warn("MARK COMPLETE: requestId missing")

        return
      }

      console.log("========================================")

      console.log("FILE_COMPLETE HANDLER START:", requestId)

      const pendingFile = pendingFilesRef.current.get(requestId)

      console.log("PENDING FILE:", JSON.stringify(pendingFile, null, 2))

      if (!pendingFile) {
        console.warn("NO PENDING FILE FOUND:", requestId)

        resolveAutoSyncWaiter(requestId, true)

        return
      }

      const isPcToAndroid = pendingFile.direction === "PC_TO_ANDROID"

      setTransfers(prev =>
        prev.map(item => {
          if (item.requestId !== requestId) {
            return item
          }

          const finalTotal = Number(
            item.total || item.transferred || pendingFile?.size || 0,
          )

          return {
            ...item,

            transferred: finalTotal,

            total: finalTotal,

            progress: 1,

            status: "completed",
          }
        }),
      )

      /*
       * فقط Android -> PC database files
       * يتم حذفها من syncFiles بعد التأكيد.
       *
       * PC -> Android لا يتم حذفها.
       */
      if (
        !isPcToAndroid &&
        pendingFile?.databaseFile &&
        pendingFile?.syncFileId
      ) {
        const syncFileId = String(pendingFile.syncFileId)

        console.log("SYNC FILE ID TO DELETE:", syncFileId)

        try {
          const beforeDelete = await db
            .select()
            .from(schema.syncFiles)
            .where(eq(schema.syncFiles.id, syncFileId))

          console.log(
            "SYNC FILE BEFORE DELETE:",
            JSON.stringify(beforeDelete, null, 2),
          )

          if (beforeDelete.length === 0) {
            console.warn("SYNC FILE NOT FOUND BEFORE DELETE:", syncFileId)
          } else {
            const deletedRows = await db
              .delete(schema.syncFiles)
              .where(eq(schema.syncFiles.id, syncFileId))
              .returning()

            console.log("DELETE RESULT:", JSON.stringify(deletedRows, null, 2))

            const afterDelete = await db
              .select()
              .from(schema.syncFiles)
              .where(eq(schema.syncFiles.id, syncFileId))

            if (afterDelete.length === 0) {
              console.log("SYNC FILE SUCCESSFULLY DELETED:", syncFileId)
            } else {
              console.error("SYNC FILE STILL EXISTS AFTER DELETE:", syncFileId)
            }
          }
        } catch (error) {
          console.error("DELETE SYNC FILE ERROR:", error)
        }
      }

      pendingFilesRef.current.delete(requestId)

      if (autoSyncCurrentRef.current === requestId) {
        autoSyncCurrentRef.current = null
      }

      resolveAutoSyncWaiter(requestId, true)

      const notificationKey = `complete:${requestId}`

      if (!notifiedTransfersRef.current.has(notificationKey)) {
        notifiedTransfersRef.current.add(notificationKey)
      }

      console.log("FILE_COMPLETE HANDLER FINISHED:", requestId)

      console.log("========================================")
    },
    [db, resolveAutoSyncWaiter],
  )

  /* ============================================================
   * DISCOVERY
   * ============================================================ */

  const startDiscovery = useCallback(() => {
    if (connectedDeviceRef.current) {
      return
    }

    clearDiscoveryTimer()
    clearDiscoveryRestartTimer()

    manualDiscoveryStopRef.current = false

    setIsDiscovering(true)
    setConnectionError(null)
    setDevices([])

    try {
      AvocatoFlow.startDiscovery()
    } catch (error) {
      console.error("START DISCOVERY ERROR:", error)

      setIsDiscovering(false)

      setConnectionError(error?.message || "تعذر بدء البحث عن الكمبيوتر.")
    }

    discoveryTimerRef.current = setTimeout(() => {
      try {
        AvocatoFlow.stopDiscovery()
      } catch (error) {
        console.log("STOP DISCOVERY AFTER TIMEOUT:", error?.message || error)
      }

      setIsDiscovering(false)
    }, DISCOVERY_TIMEOUT)
  }, [clearDiscoveryTimer, clearDiscoveryRestartTimer])

  const stopDiscovery = useCallback(
    (manual = true) => {
      clearDiscoveryTimer()

      if (manual) {
        manualDiscoveryStopRef.current = true
      }

      try {
        AvocatoFlow.stopDiscovery()
      } catch (error) {
        console.log("STOP DISCOVERY ERROR:", error?.message || error)
      }

      setIsDiscovering(false)
    },
    [clearDiscoveryTimer],
  )

  const scheduleAutoReconnect = useCallback(() => {
    if (manualDisconnectRef.current) {
      return
    }

    if (connectedDeviceRef.current) {
      return
    }

    if (reconnectTimerRef.current) {
      return
    }

    const attempt = reconnectAttemptRef.current + 1

    reconnectAttemptRef.current = attempt

    const delay = Math.min(2000 + (attempt - 1) * 1000, 5000)

    console.log("NETWORK AUTO RECONNECT SCHEDULED:", {
      attempt,
      delay,
    })

    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null

      if (manualDisconnectRef.current) {
        return
      }

      if (connectedDeviceRef.current) {
        return
      }

      if (autoConnectAttemptRef.current) {
        console.log(
          "NETWORK AUTO RECONNECT SKIPPED: CONNECTION ATTEMPT ALREADY RUNNING",
        )

        return
      }

      const savedPc = await getTrustedPc()

      if (!savedPc?.id) {
        reconnectAttemptRef.current = 0
        return
      }

      if (!savedPc.ip) {
        console.log("NETWORK AUTO RECONNECT: NO IP -> DISCOVERY")

        try {
          startDiscovery()
        } catch (error) {
          console.error("RECONNECT DISCOVERY ERROR:", error)

          scheduleAutoReconnect()
        }

        return
      }

      const websocketPort = Number(
        savedPc.websocketPort || savedPc.port || DEFAULT_WEBSOCKET_PORT,
      )

      try {
        /*
         * هذه محاولة اتصال جديدة.
         * لذلك نسمح بمعالجة disconnect/error جديد.
         */
        disconnectHandledRef.current = false

        autoConnectAttemptRef.current = true

        setAutoConnecting(true)
        setConnectingId(savedPc.id)
        setConnectionError(null)

        try {
          AvocatoFlow.stopDiscovery()
        } catch {}

        setIsDiscovering(false)

        console.log("NETWORK AUTO RECONNECT TRY:", {
          attempt,
          id: savedPc.id,
          ip: savedPc.ip,
          websocketPort,
        })
        connectionGenerationRef.current += 1

        disconnectGenerationRef.current = connectionGenerationRef.current

        disconnectHandledRef.current = false
        AvocatoFlow.connect(savedPc.ip, websocketPort)
      } catch (error) {
        console.error("NETWORK AUTO RECONNECT ERROR:", error)

        autoConnectAttemptRef.current = false

        setConnectingId(null)
        setAutoConnecting(false)

        if (!manualDisconnectRef.current) {
          scheduleAutoReconnect()
        }
      }
    }, delay)
  }, [getTrustedPc, startDiscovery])
  /* ============================================================
   * TRUSTED PC
   * ============================================================ */

  const getTrustedPc = useCallback(async () => {
    try {
      const value = await AsyncStorage.getItem(TRUSTED_PC_KEY)

      if (!value) {
        return null
      }

      return JSON.parse(value)
    } catch (error) {
      console.error("LOAD TRUSTED PC ERROR:", error)

      return null
    }
  }, [])

  const saveTrustedPc = useCallback(async device => {
    if (!device?.id) {
      return
    }

    const normalizedDevice = {
      id: device.id,

      name: device.name || "Windows PC",

      platform: device.platform || "windows",

      ip: device.ip || null,

      websocketPort: Number(
        device.websocketPort || device.port || DEFAULT_WEBSOCKET_PORT,
      ),

      httpPort: Number(device.httpPort || DEFAULT_HTTP_PORT),

      trusted: true,
    }

    try {
      await AsyncStorage.setItem(
        TRUSTED_PC_KEY,
        JSON.stringify(normalizedDevice),
      )

      setTrustedPc(normalizedDevice)
    } catch (error) {
      console.error("SAVE TRUSTED PC ERROR:", error)
    }
  }, [])

  const removeTrustedPc = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(TRUSTED_PC_KEY)

      setTrustedPc(null)
    } catch (error) {
      console.error("REMOVE TRUSTED PC ERROR:", error)
    }
  }, [])

  /* ============================================================
   * DISCOVERY EVENT
   * ============================================================ */

  useEffect(() => {
    if (!AvocatoFlow || typeof AvocatoFlow.addListener !== "function") {
      console.error("AvocatoFlow.addListener is not available")

      return undefined
    }

    const subscription = AvocatoFlow.addListener("onDeviceFound", event => {
      const response = event?.response

      if (!response) {
        return
      }

      let data

      try {
        data = typeof response === "string" ? JSON.parse(response) : response
      } catch (error) {
        console.error("INVALID DISCOVERY RESPONSE:", error)

        return
      }

      if (data?.type !== "FLOW_CONNECT_PC") {
        return
      }

      const device = {
        id: data.id,

        name: data.name || "Windows PC",

        platform: data.platform || "windows",

        ip: event?.ip || data.ip,

        websocketPort: Number(
          data.websocketPort || data.port || DEFAULT_WEBSOCKET_PORT,
        ),

        httpPort: Number(data.httpPort || DEFAULT_HTTP_PORT),
      }

      setDevices(prev => {
        const exists = prev.find(item => item.id === device.id)

        if (exists) {
          return prev.map(item =>
            item.id === device.id
              ? {
                  ...item,
                  ...device,
                }
              : item,
          )
        }

        return [...prev, device]
      })
    })

    return () => {
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove()
      }
    }
  }, [])

  /* ============================================================
   * DATABASE SYNC
   * ============================================================ */

  const startDatabaseSync = useCallback(async () => {
    if (!connectedDeviceRef.current) {
      console.log("DATABASE SYNC: No connected device")

      return
    }

    if (!isTrusted) {
      console.log("DATABASE SYNC: Device is not trusted")

      return
    }

    if (databaseSyncRunningRef.current) {
      console.log("DATABASE SYNC: Already running")

      return
    }

    const syncPeerId = connectedDeviceRef.current?.id

    if (!syncPeerId) {
      console.log("DATABASE SYNC: Peer device ID missing")

      return
    }

    try {
      databaseSyncRunningRef.current = true

      setDatabaseSyncing(true)

      const syncTime = new Date().toISOString()

      const payload = await createDatabaseSyncPayload(db, syncPeerId, syncTime)

      const requestId = Crypto.randomUUID()

      databaseSyncRequestRef.current = {
        requestId,

        syncTime,

        peerId: syncPeerId,

        lastSyncAt: payload.lastSyncAt || null,
      }

      console.log("========================================")

      console.log("DATABASE SYNC START")

      console.log({
        requestId,
        peerId: syncPeerId,
        syncTime,

        lastSyncAt: payload.lastSyncAt,

        changes: getChangesCount(payload.changes),
      })

      console.log("========================================")

      AvocatoFlow.sendMessage(
        JSON.stringify({
          type: "DATABASE_SYNC_REQUEST",

          version: 1,

          requestId,

          timestamp: Date.now(),

          payload: {
            ...payload,

            requestId,

            deviceId: syncPeerId,

            syncTime,
          },
        }),
      )
    } catch (error) {
      console.error("DATABASE SYNC START ERROR:", error)

      databaseSyncRequestRef.current = null

      databaseSyncRunningRef.current = false

      setDatabaseSyncing(false)
    }
  }, [db, isTrusted])

  /* ============================================================
   * WEBSOCKET MESSAGES
   * ============================================================ */

  useEffect(() => {
    if (!AvocatoFlow || typeof AvocatoFlow.addListener !== "function") {
      console.error("AvocatoFlow.addListener is not available")

      return undefined
    }

    const subscription = AvocatoFlow.addListener("onMessage", async event => {
      const raw = event?.message

      if (!raw) {
        return
      }

      let message

      try {
        message = typeof raw === "string" ? JSON.parse(raw) : raw
      } catch (error) {
        console.error("INVALID FLOW MESSAGE:", error)

        return
      }

      const type = message?.type

      const payload = message?.payload || {}

      /* ======================================================
       * DATABASE_SYNC_DATA
       * ====================================================== */

      if (type === "DATABASE_SYNC_DATA") {
        try {
          const changes = payload?.changes || {}

          const syncTime =
            payload?.syncTime ||
            databaseSyncRequestRef.current?.syncTime ||
            null

          const baseSyncAt =
            payload?.baseSyncAt ||
            databaseSyncRequestRef.current?.lastSyncAt ||
            null

          if (!syncTime) {
            throw new Error("SYNC_TIME_MISSING")
          }

          console.log("========================================")

          console.log("DATABASE SYNC DATA RECEIVED")

          console.log({
            syncTime,
            baseSyncAt,

            changes: getChangesCount(changes),
          })

          console.log("========================================")

          const applyResult = await applyChanges(db, changes)

          console.log("WINDOWS -> ANDROID APPLY:", applyResult)

          AvocatoFlow.sendMessage(
            JSON.stringify({
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

                applyResult,
              },
            }),
          )
        } catch (error) {
          console.error("WINDOWS -> ANDROID APPLY ERROR:", error)

          AvocatoFlow.sendMessage(
            JSON.stringify({
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
                  payload?.syncTime ||
                  databaseSyncRequestRef.current?.syncTime ||
                  null,

                error: error?.message || String(error),
              },
            }),
          )
        }

        return
      }

      /* ======================================================
       * DATABASE_SYNC_COMPLETE
       * ====================================================== */

      if (type === "DATABASE_SYNC_COMPLETE") {
        try {
          console.log("========================================")

          console.log("DATABASE_SYNC_COMPLETE RECEIVED")

          console.log("PAYLOAD:", payload)

          console.log("========================================")

          const success = Boolean(payload?.success)

          const syncTime =
            payload?.syncTime ||
            databaseSyncRequestRef.current?.syncTime ||
            null

          const syncPeerId =
            connectedDeviceRef.current?.id ||
            databaseSyncRequestRef.current?.peerId ||
            null

          if (!success) {
            throw new Error(payload?.error || "DATABASE_SYNC_FAILED")
          }

          if (!syncTime) {
            throw new Error("SYNC_TIME_MISSING")
          }

          if (!syncPeerId) {
            throw new Error("SYNC_PEER_ID_MISSING")
          }

          await setLastSyncAt(db, syncPeerId, syncTime)

          console.log("ANDROID LAST SYNC UPDATED:", {
            syncPeerId,
            syncTime,
          })

          databaseSyncRequestRef.current = null

          databaseSyncRunningRef.current = false

          setDatabaseSyncing(false)
          setDatabaseSyncSuccess(true)

          setTimeout(() => {
            setDatabaseSyncSuccess(false)
          }, 4000)

          console.log("========================================")

          console.log("DATABASE SYNC FINISHED SUCCESSFULLY")

          console.log("========================================")
        } catch (error) {
          console.error("DATABASE_SYNC_COMPLETE ERROR:", error)

          databaseSyncRequestRef.current = null

          databaseSyncRunningRef.current = false

          setDatabaseSyncing(false)
        }

        return
      }

      /* ======================================================
       * DATABASE_SYNC_ERROR
       * ====================================================== */

      if (type === "DATABASE_SYNC_ERROR") {
        console.error("DATABASE SYNC ERROR:", payload)

        databaseSyncRequestRef.current = null

        databaseSyncRunningRef.current = false

        setDatabaseSyncing(false)

        return
      }

      /* ======================================================
       * WELCOME
       * ====================================================== */

      if (type === "WELCOME") {
        const trusted = Boolean(payload.trusted)

        setIsTrusted(trusted)

        if (trusted) {
          const device =
            connectedDeviceRef.current ||
            devices.find(item => item.id === connectingId) ||
            trustedPc

          if (device?.id) {
            const savedDevice = {
              ...device,

              trusted: true,
            }

            connectedDeviceRef.current = savedDevice

            setConnectedDevice(savedDevice)

            await saveTrustedPc(savedDevice)
          }
        }

        return
      }

      /* ======================================================
       * PAIR_ALREADY_TRUSTED
       * ====================================================== */

      if (type === "PAIR_ALREADY_TRUSTED") {
        setIsTrusted(true)

        const device = connectedDeviceRef.current

        if (device) {
          saveTrustedPc({
            ...device,
            trusted: true,
          })
        }

        return
      }

      /* ======================================================
       * PAIR_CODE
       * ====================================================== */

      if (type === "PAIR_CODE") {
        const code = payload.code

        const requestId = message.requestId || payload.requestId

        setPairRequest({
          requestId,
          code,
        })

        setPairCodeInput("")

        setPairConfirmVisible(true)

        return
      }

      /* ======================================================
       * PAIR_ACCEPT
       * ====================================================== */

      if (type === "PAIR_ACCEPT") {
        setIsTrusted(true)

        const device =
          connectedDeviceRef.current ||
          devices.find(item => item.id === connectingId)

        if (device?.id) {
          const savedDevice = {
            ...device,
            trusted: true,
          }

          connectedDeviceRef.current = savedDevice

          setConnectedDevice(savedDevice)

          await saveTrustedPc(savedDevice)
        }

        Alert.alert("تم الاقتران", "تم ربط الهاتف بالكمبيوتر بنجاح.")

        return
      }

      /* ======================================================
       * TEST
       * ====================================================== */

      if (type === "TEST_RESPONSE") {
        setIsSendingTest(false)

        Alert.alert("نجاح", "تم الاتصال بالكمبيوتر واستلام الرد.")

        return
      }

      if (type === "PONG") {
        return
      }

      /* ======================================================
       * ERROR
       * ====================================================== */

      if (type === "ERROR") {
        const errorMessage = payload?.message || "حدث خطأ في الاتصال."

        console.error("SERVER ERROR:", errorMessage)

        setConnectionError(errorMessage)

        return
      }

      /* ======================================================
       * FILE_SEND_REQUEST
       *
       * PC -> Android
       * ====================================================== */

      if (type === "FILE_SEND_REQUEST") {
        const requestId = message?.requestId || payload?.requestId

        const transferId = payload?.transferId || message?.transferId

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

        console.log("FILE_SEND_REQUEST RECEIVED:", {
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

        /* --------------------------------------------------
         * Security
         * -------------------------------------------------- */

        if (!isTrusted) {
          console.error("FILE_SEND_REQUEST REJECTED: DEVICE_NOT_TRUSTED")

          try {
            AvocatoFlow.sendMessage(
              JSON.stringify({
                type: "FILE_REJECT",

                version: 1,

                requestId,

                transferId,

                timestamp: Date.now(),

                payload: {
                  requestId,

                  transferId,

                  message: "الجهاز غير موثوق.",

                  code: "DEVICE_NOT_TRUSTED",
                },
              }),
            )
          } catch (error) {
            console.error("SEND FILE_REJECT ERROR:", error)
          }

          return
        }

        if (!connectedDeviceRef.current?.ip) {
          console.error("FILE_SEND_REQUEST REJECTED: PC_IP_MISSING")

          try {
            AvocatoFlow.sendMessage(
              JSON.stringify({
                type: "FILE_REJECT",

                version: 1,

                requestId,

                transferId,

                timestamp: Date.now(),

                payload: {
                  requestId,

                  transferId,

                  message: "لم يتم العثور على عنوان IP للكمبيوتر.",

                  code: "PC_IP_MISSING",
                },
              }),
            )
          } catch (error) {
            console.error("SEND FILE_REJECT ERROR:", error)
          }

          return
        }

        if (!requestId) {
          console.error("FILE_SEND_REQUEST: requestId missing")

          return
        }

        if (!transferId) {
          console.error("FILE_SEND_REQUEST: transferId missing")

          return
        }

        if (!Number.isFinite(fileSize) || fileSize < 0) {
          console.error("FILE_SEND_REQUEST: invalid fileSize")

          return
        }

        /* --------------------------------------------------
         * Duplicate protection
         * -------------------------------------------------- */

        const existingRequest = pendingFilesRef.current.get(requestId)

        if (existingRequest && existingRequest.direction === "PC_TO_ANDROID") {
          console.log("FILE_SEND_REQUEST DUPLICATE:", requestId)

          return
        }

        /* --------------------------------------------------
         * Start native download
         * -------------------------------------------------- */

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
          console.error("PC -> ANDROID DOWNLOAD ERROR:", error)

          await handleIncomingFileError({
            requestId,
            transferId,

            error: error?.message || String(error),
          })

          try {
            AvocatoFlow.sendMessage(
              JSON.stringify({
                type: "FILE_ERROR",

                version: 1,

                requestId,

                transferId,

                timestamp: Date.now(),

                payload: {
                  requestId,

                  transferId,

                  message: error?.message || "فشل تنزيل الملف إلى الهاتف.",

                  error: error?.message || String(error),

                  direction: "PC_TO_ANDROID",
                },
              }),
            )
          } catch (sendError) {
            console.error("SEND PC -> ANDROID FILE_ERROR ERROR:", sendError)
          }
        })

        return
      }

      /* ======================================================
       * FILE_ACCEPT
       *
       * Android -> PC
       * ====================================================== */

      if (type === "FILE_ACCEPT") {
        const requestId = message?.requestId || payload?.requestId

        const transferId = payload?.transferId || message?.transferId

        const uploadUrl = payload?.uploadUrl || message?.uploadUrl

        const startByte = Number(
          payload?.receivedBytes ?? payload?.startByte ?? payload?.offset ?? 0,
        )

        if (!transferId) {
          console.error("INVALID FILE_ACCEPT: transferId missing", message)

          return
        }

        if (!uploadUrl) {
          console.error("INVALID FILE_ACCEPT: uploadUrl missing", message)

          return
        }

        let pendingFile = null

        let resolvedRequestId = requestId

        if (requestId) {
          pendingFile = pendingFilesRef.current.get(requestId)
        }

        if (!pendingFile && transferId) {
          const foundRequestId = findRequestIdByTransferId(transferId)

          if (foundRequestId) {
            pendingFile = pendingFilesRef.current.get(foundRequestId)

            resolvedRequestId = foundRequestId
          }
        }

        if (!pendingFile) {
          console.error("PENDING FILE NOT FOUND:", {
            requestId,
            transferId,

            pendingFiles: Array.from(pendingFilesRef.current.keys()),
          })

          return
        }

        if (!resolvedRequestId) {
          return
        }

        const pc = connectedDeviceRef.current

        if (!pc?.ip) {
          markTransferError(
            resolvedRequestId,
            "لم يتم العثور على عنوان IP للكمبيوتر.",
          )

          return
        }

        const updatedPendingFile = {
          ...pendingFile,

          requestId: resolvedRequestId,

          transferId,
        }

        pendingFilesRef.current.set(resolvedRequestId, updatedPendingFile)

        const httpPort = Number(pc.httpPort || DEFAULT_HTTP_PORT)

        let fullUploadUrl

        if (/^https?:\/\//i.test(uploadUrl)) {
          fullUploadUrl = uploadUrl
        } else {
          const normalizedPath = uploadUrl.startsWith("/")
            ? uploadUrl
            : `/${uploadUrl}`

          fullUploadUrl = `http://${pc.ip}:${httpPort}${normalizedPath}`
        }

        const fileSize = Number(pendingFile.size || 0)

        updateTransfer(resolvedRequestId, {
          id: resolvedRequestId,

          requestId: resolvedRequestId,

          transferId,

          fileName: pendingFile.name || "File",

          total: fileSize,

          transferred: Math.max(0, startByte),

          progress: fileSize > 0 ? Math.min(1, startByte / fileSize) : 0,

          status: "transferring",
        })

        try {
          const uploadResult = AvocatoFlow.uploadFile(
            pendingFile.uri,

            transferId,

            fullUploadUrl,

            startByte,
          )

          if (uploadResult && typeof uploadResult.then === "function") {
            uploadResult.catch(error => {
              console.error("ASYNC UPLOAD FILE ERROR:", error)

              markTransferError(
                resolvedRequestId,

                error?.message || "تعذر نقل الملف.",
              )
            })
          }
        } catch (error) {
          console.error("UPLOAD FILE ERROR:", error)

          markTransferError(
            resolvedRequestId,

            error?.message || "تعذر بدء نقل الملف.",
          )
        }

        return
      }

      /* ======================================================
       * FILE_SEND_ACCEPT
       *
       * PC acknowledgement for PC -> Android
       * ====================================================== */

      if (type === "FILE_SEND_ACCEPT") {
        console.log("FILE_SEND_ACCEPT RECEIVED:", message)

        return
      }

      /* ======================================================
       * FILE_REJECT
       * ====================================================== */

      if (type === "FILE_REJECT") {
        const requestId = resolveRequestId(message, payload)

        const errorMessage = payload?.message || "رفض الكمبيوتر نقل الملف."

        if (requestId) {
          markTransferError(requestId, errorMessage)
        } else {
          Alert.alert("رفض نقل الملف", errorMessage)
        }

        return
      }

      /* ======================================================
       * FILE_PROGRESS
       * ====================================================== */

      if (type === "FILE_PROGRESS") {
        const transferId = payload?.transferId || message?.transferId

        const requestId = resolveRequestId(message, payload)

        const transferred = Number(
          payload?.transferred ??
            payload?.receivedBytes ??
            payload?.bytesTransferred ??
            0,
        )

        const total = Number(payload?.total ?? payload?.fileSize ?? 0)

        if (!requestId) {
          return
        }

        setTransfers(prev =>
          prev.map(item => {
            if (item.requestId !== requestId) {
              return item
            }

            const isIncoming = item.direction === "PC_TO_ANDROID"

            const currentTransferred = Number(item.transferred || 0)

            const incomingTransferred = isIncoming
              ? Math.max(currentTransferred, transferred)
              : transferred

            const finalTotal = total || item.total || 0

            const finalTransferred =
              finalTotal > 0
                ? Math.min(incomingTransferred, finalTotal)
                : incomingTransferred

            return {
              ...item,

              transferId: transferId || item.transferId,

              transferred: finalTransferred,

              total: finalTotal,

              status:
                item.status === "completed" ? "completed" : "transferring",
            }
          }),
        )

        return
      }

      /* ======================================================
       * FILE_COMPLETE
       * ====================================================== */

      if (type === "FILE_COMPLETE") {
        const transferId = payload?.transferId || message?.transferId

        console.log("FILE_COMPLETE MESSAGE:", JSON.stringify(message, null, 2))

        const requestId = resolveRequestId(message, payload)

        if (!requestId) {
          console.warn("FILE_COMPLETE: REQUEST ID NOT FOUND", {
            transferId,
            message,

            pendingFiles: Array.from(pendingFilesRef.current.entries()),
          })

          return
        }

        await markTransferCompleted(requestId)

        return
      }

      /* ======================================================
       * FILE_ERROR
       * ====================================================== */

      if (type === "FILE_ERROR") {
        const transferId = payload?.transferId || message?.transferId

        const requestId = resolveRequestId(message, payload)

        const errorMessage =
          payload?.message ||
          payload?.error ||
          message?.error ||
          "فشل نقل الملف."

        console.error("FILE ERROR MESSAGE:", {
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

      /* ======================================================
       * UNPAIR
       * ====================================================== */

      if (type === "UNPAIR_SUCCESS") {
        setIsTrusted(false)

        await removeTrustedPc()

        return
      }
    })

    return () => {
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove()
      }
    }
  }, [
    saveTrustedPc,
    removeTrustedPc,
    devices,
    connectingId,
    trustedPc,
    findRequestIdByTransferId,
    resolveRequestId,
    updateTransfer,
    markTransferError,
    markTransferCompleted,
    db,
    isTrusted,
    downloadIncomingFile,
    handleIncomingFileError,
    sendFileSendAccept,
  ])

  /* ============================================================
   * CONNECTION STATE
   * ============================================================ */

  useEffect(() => {
    if (!AvocatoFlow || typeof AvocatoFlow.addListener !== "function") {
      console.error("AvocatoFlow.addListener is not available")

      return undefined
    }

    const subscription = AvocatoFlow.addListener(
      "onConnectionStateChanged",
      async event => {
        const connected = Boolean(event?.connected)

        /*
         * ======================================================
         * CONNECTED
         * ======================================================
         */
        if (connected) {
          console.log("NETWORK CONNECTION ESTABLISHED")

          disconnectHandledRef.current = false

          clearReconnectTimer()

          reconnectAttemptRef.current = 0

          setConnectingId(null)

          setAutoConnecting(false)

          setConnectionError(null)

          setIsDiscovering(false)

          autoConnectAttemptRef.current = false

          const device =
            connectedDeviceRef.current ||
            devices.find(item => item.id === connectingId) ||
            trustedPc

          if (device?.id) {
            connectedDeviceRef.current = device

            setConnectedDevice(device)
          }

          databaseAutoSyncStartedRef.current = false

          autoSyncStartedRef.current = false

          autoSyncFilesRef.current.clear()

          autoSyncQueueRef.current = []

          autoSyncCurrentRef.current = null

          try {
            AvocatoFlow.stopDiscovery()
          } catch (error) {
            console.log(
              "STOP DISCOVERY AFTER CONNECT:",
              error?.message || error,
            )
          }

          return
        }

        /*
         * ======================================================
         * DISCONNECTED
         * ======================================================
         *
         * onConnectionError قد يكون أرسل قبل هذه الحالة.
         * لذلك لا نعالج نفس الانقطاع مرتين.
         */
        if (disconnectHandledRef.current) {
          console.log("NETWORK DISCONNECT IGNORED: ALREADY HANDLED")

          return
        }

        disconnectHandledRef.current = true

        console.log("NETWORK CONNECTION LOST -> AUTO RECONNECT")

        /*
         * إيقاف أي downloads معلقة
         */
        for (const [transferId, download] of incomingDownloadsRef.current) {
          try {
            if (typeof download.pauseAsync === "function") {
              await download.pauseAsync()
            }
          } catch (_) {}

          console.log("PAUSED DOWNLOAD AFTER CONNECTION CLOSED:", transferId)
        }

        incomingDownloadsRef.current.clear()

        /*
         * Connection state
         */
        setConnectedDevice(null)

        connectedDeviceRef.current = null

        setIsTrusted(false)

        setConnectingId(null)

        setAutoConnecting(false)

        setIsSendingTest(false)

        /*
         * Database sync
         */
        databaseSyncRequestRef.current = null

        databaseSyncRunningRef.current = false

        setDatabaseSyncing(false)

        databaseAutoSyncStartedRef.current = false

        /*
         * File auto sync
         */
        autoSyncStartedRef.current = false

        autoSyncQueueRef.current = []

        autoSyncCurrentRef.current = null

        for (const [requestId, waiter] of autoSyncWaitersRef.current) {
          try {
            waiter.reject(new Error("CONNECTION_CLOSED"))
          } catch (_) {}
        }

        autoSyncWaitersRef.current.clear()

        autoConnectAttemptRef.current = false

        /*
         * Manual disconnect:
         * لا تعمل Auto Reconnect.
         */
        if (manualDisconnectRef.current) {
          manualDisconnectRef.current = false

          clearReconnectTimer()

          reconnectAttemptRef.current = 0

          return
        }

        /*
         * Network disconnect:
         * ابدأ محاولة reconnect واحدة فقط.
         */
        scheduleAutoReconnect()
      },
    )

    return () => {
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove()
      }
    }
  }, [
    scheduleAutoReconnect,
    clearReconnectTimer,
    devices,
    connectingId,
    trustedPc,
  ])
  /* ============================================================
   * CONNECTION ERROR
   * ============================================================ */

  useEffect(() => {
    if (!AvocatoFlow || typeof AvocatoFlow.addListener !== "function") {
      console.error("AvocatoFlow.addListener is not available")

      return undefined
    }

    const subscription = AvocatoFlow.addListener("onConnectionError", event => {
      const rawError = event?.error

      const message =
        rawError?.message || rawError || "تعذر الاتصال بالكمبيوتر."

      const errorText = String(message)

      /*
       * =====================================================
       * CONNECTION ERROR
       * =====================================================
       *
       * الخطأ هنا خاص بمحاولة الاتصال.
       * إذا كان الاتصال تلقائيًا، لا نعرض الخطأ للمستخدم.
       */

      const isAutoConnection =
        autoConnectAttemptRef.current || Boolean(trustedPc?.ip)

      /*
       * أخطاء الاتصال الطبيعية أثناء محاولة
       * الوصول إلى PC مغلق.
       */
      const isConnectionAbort =
        /software caused connection abort/i.test(errorText) ||
        /connection abort/i.test(errorText) ||
        /connection reset/i.test(errorText) ||
        /socket closed/i.test(errorText) ||
        /connection closed/i.test(errorText) ||
        /websocket closed/i.test(errorText) ||
        /websocket connection closed/i.test(errorText) ||
        /econnreset/i.test(errorText) ||
        /econnaborted/i.test(errorText) ||
        /broken pipe/i.test(errorText) ||
        /connection refused/i.test(errorText) ||
        /failed to connect/i.test(errorText)

      /*
       * =====================================================
       * LOG ONLY
       * =====================================================
       *
       * لا نستخدم console.error في حالة
       * Auto Reconnect حتى لا يظهر كخطأ أثناء
       * فتح التطبيق والـPC مغلق.
       */
      if (isAutoConnection || isConnectionAbort) {
        console.log("NETWORK AUTO CONNECT WAITING:", errorText)
      } else {
        console.error("CONNECTION ERROR:", errorText)
      }

      /*
       * =====================================================
       * DUPLICATE DISCONNECT GUARD
       * =====================================================
       *
       * onConnectionError و
       * onConnectionStateChanged(false)
       * قد يصلان لنفس الانقطاع.
       */
      if (disconnectHandledRef.current) {
        console.log("NETWORK CONNECTION ERROR: DISCONNECT ALREADY HANDLED")

        return
      }

      disconnectHandledRef.current = true

      /*
       * =====================================================
       * CLEAR CONNECTION STATE
       * =====================================================
       */

      /*
       * مهم جدًا:
       *
       * لا نضع errorText في connectionError
       * أثناء Auto Reconnect.
       *
       * وبالتالي لن يظهر للمستخدم:
       *
       * failed to connect...
       */
      if (!isAutoConnection) {
        setConnectionError(isConnectionAbort ? null : errorText)
      } else {
        setConnectionError(null)
      }

      setConnectingId(null)

      setAutoConnecting(false)

      setIsSendingTest(false)

      setConnectedDevice(null)

      connectedDeviceRef.current = null

      setIsTrusted(false)

      autoConnectAttemptRef.current = false

      /*
       * =====================================================
       * DATABASE SYNC
       * =====================================================
       */

      databaseSyncRequestRef.current = null

      databaseSyncRunningRef.current = false

      setDatabaseSyncing(false)

      databaseAutoSyncStartedRef.current = false

      /*
       * =====================================================
       * FILE AUTO SYNC
       * =====================================================
       */

      autoSyncStartedRef.current = false

      autoSyncQueueRef.current = []

      autoSyncCurrentRef.current = null

      /*
       * =====================================================
       * PAUSE INCOMING DOWNLOADS
       * =====================================================
       */

      for (const [transferId, download] of incomingDownloadsRef.current) {
        try {
          if (typeof download.pauseAsync === "function") {
            download.pauseAsync()
          }
        } catch (_) {}

        console.log("PAUSED DOWNLOAD AFTER CONNECTION ERROR:", transferId)
      }

      incomingDownloadsRef.current.clear()

      /*
       * =====================================================
       * MANUAL DISCONNECT
       * =====================================================
       */

      if (manualDisconnectRef.current) {
        manualDisconnectRef.current = false

        clearReconnectTimer()

        reconnectAttemptRef.current = 0

        return
      }

      /*
       * =====================================================
       * AUTO RECONNECT
       * =====================================================
       */

      console.log("NETWORK CONNECTION ERROR -> AUTO RECONNECT")

      scheduleAutoReconnect()
    })

    return () => {
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove()
      }
    }
  }, [scheduleAutoReconnect, clearReconnectTimer, trustedPc])
  /* ============================================================
   * NATIVE FILE PROGRESS
   * ============================================================ */

  useEffect(() => {
    if (!AvocatoFlow || typeof AvocatoFlow.addListener !== "function") {
      return undefined
    }

    const subscription = AvocatoFlow.addListener("onFileProgress", event => {
      const transferId = event?.transferId

      let requestId = event?.requestId

      if (!requestId && transferId) {
        requestId = findRequestIdByTransferId(transferId)
      }

      if (!requestId) {
        return
      }

      const transferred = Number(
        event?.transferred ??
          event?.receivedBytes ??
          event?.bytesTransferred ??
          0,
      )

      const total = Number(event?.total ?? event?.fileSize ?? 0)

      setTransfers(prev =>
        prev.map(item => {
          if (item.requestId !== requestId) {
            return item
          }

          const currentTransferred = Number(item.transferred || 0)

          const finalTransferred = Math.max(currentTransferred, transferred)

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

            status: item.status === "completed" ? "completed" : "transferring",
          }
        }),
      )
    })

    return () => {
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove()
      }
    }
  }, [findRequestIdByTransferId])

  /* ============================================================
   * NATIVE FILE COMPLETED
   * ============================================================ */

  useEffect(() => {
    if (!AvocatoFlow || typeof AvocatoFlow.addListener !== "function") {
      return undefined
    }

    const subscription = AvocatoFlow.addListener(
      "onFileCompleted",
      async event => {
        const transferId = event?.transferId

        let requestId = event?.requestId

        if (!requestId && transferId) {
          requestId = findRequestIdByTransferId(transferId)
        }

        if (!requestId) {
          console.warn("NATIVE FILE COMPLETED: requestId not found", {
            transferId,
          })

          return
        }

        console.log("NATIVE FILE DOWNLOAD COMPLETED:", {
          requestId,
          transferId,
        })

        /*
         * UI first.
         */
        setTransfers(prev =>
          prev.map(item => {
            if (item.requestId !== requestId) {
              return item
            }

            const finalTotal = Number(item.total || item.transferred || 0)

            return {
              ...item,

              transferId: transferId || item.transferId,

              transferred: finalTotal,

              total: finalTotal,

              progress: 1,

              status: "completed",
            }
          }),
        )

        /*
         * markTransferCompleted
         *
         * PC -> Android has
         * databaseFile:false
         */
        await markTransferCompleted(requestId)
      },
    )

    return () => {
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove()
      }
    }
  }, [findRequestIdByTransferId, markTransferCompleted])

  /* ============================================================
   * NATIVE FILE ERROR
   * ============================================================ */

  useEffect(() => {
    if (!AvocatoFlow || typeof AvocatoFlow.addListener !== "function") {
      return undefined
    }

    const subscription = AvocatoFlow.addListener("onFileError", event => {
      const transferId = event?.transferId

      const error = event?.error?.message || event?.error || "فشل نقل الملف."

      let requestId = event?.requestId

      if (!requestId && transferId) {
        requestId = findRequestIdByTransferId(transferId)
      }

      console.error("NATIVE FILE ERROR:", {
        requestId,
        transferId,
        error,
      })

      if (requestId) {
        markTransferError(requestId, String(error))

        return
      }

      Alert.alert("خطأ في نقل الملف", String(error))
    })

    return () => {
      if (subscription && typeof subscription.remove === "function") {
        subscription.remove()
      }
    }
  }, [findRequestIdByTransferId, markTransferError])

  /* ============================================================
   * CONNECT
   * ============================================================ */

  const handleConnect = useCallback(
    device => {
      if (!device?.ip) {
        Alert.alert("خطأ", "لم يتم العثور على عنوان IP للكمبيوتر.")
        return
      }

      const websocketPort = Number(
        device.websocketPort || device.port || DEFAULT_WEBSOCKET_PORT,
      )

      // إلغاء أي reconnect timer سابق
      clearReconnectTimer()

      // مهم:
      // لا نضع هنا:
      // reconnectAttemptRef.current = 0
      //
      // يتم تصفير عداد reconnect فقط بعد نجاح الاتصال.

      connectionGenerationRef.current += 1

      disconnectGenerationRef.current = connectionGenerationRef.current

      disconnectHandledRef.current = false

      setConnectingId(device.id)
      setConnectionError(null)
      setConnectedDevice(null)

      connectedDeviceRef.current = null

      setIsTrusted(false)
      setAutoConnecting(false)

      // توجد الآن محاولة اتصال
      autoConnectAttemptRef.current = true

      // إعادة تهيئة حالة مزامنة قاعدة البيانات
      databaseAutoSyncStartedRef.current = false

      // إعادة تهيئة مزامنة الملفات
      autoSyncStartedRef.current = false
      autoSyncFilesRef.current.clear()
      autoSyncQueueRef.current = []
      autoSyncCurrentRef.current = null

      // إيقاف Discovery قبل إنشاء اتصال مباشر
      try {
        AvocatoFlow.stopDiscovery()
      } catch (error) {
        console.log("STOP DISCOVERY BEFORE CONNECT:", error?.message || error)
      }

      setIsDiscovering(false)

      console.log("NETWORK CONNECT:", {
        id: device.id,
        name: device.name,
        ip: device.ip,
        websocketPort,
      })

      try {
        AvocatoFlow.connect(device.ip, websocketPort)
      } catch (error) {
        console.error("CONNECT ERROR:", error)

        setConnectingId(null)
        setConnectionError(error?.message || "تعذر بدء الاتصال.")

        // انتهت محاولة الاتصال الحالية
        autoConnectAttemptRef.current = false

        // إذا لم يكن المستخدم هو من طلب الفصل،
        // نبدأ Auto Reconnect
        if (!manualDisconnectRef.current) {
          scheduleAutoReconnect()
        }
      }
    },
    [clearReconnectTimer, scheduleAutoReconnect],
  )
  /* ============================================================
   * AUTO CONNECT TRUSTED PC
   * ============================================================ */

  useEffect(() => {
    if (!trustedPc?.id) {
      return
    }

    if (manualDisconnectRef.current) {
      return
    }

    if (connectedDeviceRef.current) {
      return
    }

    if (connectingId) {
      return
    }

    if (autoConnectAttemptRef.current) {
      return
    }

    /*
     * أولاً:
     * الاتصال مباشرة بالـ IP المحفوظ.
     */
    if (trustedPc.ip) {
      autoConnectAttemptRef.current = true

      setAutoConnecting(true)
      setConnectingId(trustedPc.id)

      handleConnect(trustedPc)

      return
    }

    /*
     * إذا لم يوجد IP محفوظ:
     * نستخدم Discovery.
     */
    const found = devices.find(device => device.id === trustedPc.id)

    if (!found) {
      return
    }

    autoConnectAttemptRef.current = true

    setAutoConnecting(true)
    setConnectingId(found.id)

    handleConnect(found)
  }, [trustedPc, devices, connectingId, handleConnect])
  /* ============================================================
   * TEST
   * ============================================================ */

  const sendTestMessage = useCallback(() => {
    if (!connectedDeviceRef.current) {
      Alert.alert("غير متصل", "قم بالاتصال بالكمبيوتر أولاً.")

      return
    }

    if (!isTrusted) {
      Alert.alert("الجهاز غير موثوق", "يجب إقران الهاتف بالكمبيوتر أولاً.")

      return
    }

    setIsSendingTest(true)

    try {
      AvocatoFlow.sendMessage(
        JSON.stringify({
          type: "TEST_MESSAGE",

          version: 1,

          timestamp: Date.now(),

          payload: {
            message: "Hello from Android",
          },
        }),
      )
    } catch (error) {
      console.error("TEST MESSAGE ERROR:", error)

      setIsSendingTest(false)

      Alert.alert("خطأ", error?.message || "تعذر إرسال الرسالة.")
    }
  }, [isTrusted])

  /* ============================================================
   * PING
   * ============================================================ */

  const sendPing = useCallback(() => {
    if (!connectedDeviceRef.current) {
      Alert.alert("غير متصل", "لا يوجد اتصال بالكمبيوتر.")

      return
    }

    try {
      AvocatoFlow.sendMessage(
        JSON.stringify({
          type: "PING",

          version: 1,

          timestamp: Date.now(),

          payload: {},
        }),
      )
    } catch (error) {
      console.error("PING ERROR:", error)
    }
  }, [])

  /* ============================================================
   * PAIRING
   * ============================================================ */

  const requestPairing = useCallback(() => {
    if (!connectedDeviceRef.current) {
      Alert.alert("غير متصل", "اتصل بالكمبيوتر أولاً.")

      return
    }

    if (isTrusted) {
      Alert.alert("تم الاقتران", "هذا الكمبيوتر موثوق بالفعل.")

      return
    }

    try {
      AvocatoFlow.sendMessage(
        JSON.stringify({
          type: "PAIR_REQUEST",

          version: 1,

          requestId: `pair-${Date.now()}`,

          timestamp: Date.now(),

          payload: {},
        }),
      )
    } catch (error) {
      console.error("PAIR REQUEST ERROR:", error)

      Alert.alert("خطأ", error?.message || "تعذر طلب الاقتران.")
    }
  }, [isTrusted])

  /* ============================================================
   * ANDROID -> PC MANUAL FILE
   * ============================================================ */

  const pickAndSendFile = useCallback(async () => {
    if (!connectedDeviceRef.current) {
      Alert.alert("غير متصل", "اتصل بالكمبيوتر أولاً.")

      return
    }

    if (!isTrusted) {
      Alert.alert("الجهاز غير موثوق", "يجب إقران الهاتف بالكمبيوتر أولاً.")

      return
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",

        copyToCacheDirectory: true,

        multiple: false,
      })

      if (result.canceled) {
        return
      }

      const file = result.assets?.[0]

      if (!file?.uri) {
        Alert.alert("خطأ", "تعذر الحصول على الملف.")

        return
      }

      const requestId = `file-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 8)}`

      pendingFilesRef.current.set(requestId, {
        ...file,

        requestId,

        transferId: null,

        direction: "ANDROID_TO_PC",

        databaseFile: false,
      })

      setTransfers(prev => [
        ...prev,

        {
          id: requestId,

          requestId,

          transferId: null,

          fileName: file.name || "File",

          total: Number(file.size || 0),

          transferred: 0,

          progress: 0,

          status: "waiting",

          direction: "ANDROID_TO_PC",
        },
      ])

      const fileSize = Number(file.size || 0)

      AvocatoFlow.sendMessage(
        JSON.stringify({
          type: "FILE_REQUEST",

          version: 1,

          requestId,

          timestamp: Date.now(),

          payload: {
            requestId,

            fileName: file.name || "file",

            fileSize,

            mimeType: file.mimeType || "application/octet-stream",
          },
        }),
      )
    } catch (error) {
      console.error("PICK FILE ERROR:", error)

      Alert.alert("خطأ", error?.message || "تعذر اختيار الملف.")
    }
  }, [isTrusted])

  /* ============================================================
   * DATABASE FILE WAITER
   * ============================================================ */

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

      console.log("AUTO SYNC WAITER REGISTERED:", requestId)
    })
  }, [])

  /* ============================================================
   * DATABASE FILE SEND
   *
   * Android -> PC
   * ============================================================ */

  const sendDatabaseFile = useCallback(
    async file => {
      if (!file?.uri) {
        console.warn("SYNC FILE URI MISSING:", file)

        return null
      }

      if (!connectedDeviceRef.current) {
        return null
      }

      if (!isTrusted) {
        return null
      }

      const syncFileId = String(file.id)

      const requestId = `dbfile-${syncFileId}-${Date.now()}-${Math.random()
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

      setTransfers(prev => [
        ...prev,

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
        },
      ])

      const completionPromise = waitForDatabaseFile(requestId)

      try {
        console.log("========================================")

        console.log("AUTO SYNC FILE_REQUEST:", {
          requestId,

          syncFileId,

          syncFileIdType: typeof syncFileId,

          fileName: file.fileName,

          uri: file.uri,
        })

        AvocatoFlow.sendMessage(
          JSON.stringify({
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
          }),
        )

        console.log("DATABASE FILE_REQUEST SENT:", {
          requestId,
          syncFileId,
        })

        return {
          requestId,

          completionPromise,
        }
      } catch (error) {
        console.error("DATABASE FILE REQUEST ERROR:", error)

        autoSyncWaitersRef.current.delete(requestId)

        markTransferError(
          requestId,

          error?.message || "تعذر إرسال طلب الملف.",
        )

        return null
      }
    },
    [isTrusted, markTransferError, waitForDatabaseFile],
  )

  /* ============================================================
   * DATABASE FILE AUTO SYNC
   * ============================================================ */

  const syncDatabaseFiles = useCallback(async () => {
    console.log("=== DATABASE AUTO SYNC START ===")

    if (!connectedDeviceRef.current) {
      console.log("AUTO SYNC STOP: no connected device")

      return
    }

    if (!isTrusted) {
      console.log("AUTO SYNC STOP: device not trusted")

      return
    }

    if (autoSyncStartedRef.current) {
      console.log("AUTO SYNC STOP: already running")

      return
    }

    autoSyncStartedRef.current = true

    try {
      console.log("AUTO SYNC: loading sync_files...")

      const files = await db.select().from(schema.syncFiles)

      console.log("AUTO SYNC FILES:", files)

      for (const file of files) {
        if (!connectedDeviceRef.current || !isTrusted) {
          console.log("AUTO SYNC STOP: connection lost")

          break
        }

        if (!file?.uri) {
          console.warn("AUTO SYNC SKIP: URI missing", file)

          continue
        }

        if (autoSyncFilesRef.current.has(file.id)) {
          console.log("AUTO SYNC SKIP: already sent", file.id)

          continue
        }

        autoSyncFilesRef.current.add(file.id)

        console.log("AUTO SYNC SENDING:", {
          id: file.id,

          fileName: file.fileName,

          uri: file.uri,

          relativePath: file.relativePath,
        })

        try {
          const result = await sendDatabaseFile(file)

          if (!result?.requestId || !result?.completionPromise) {
            throw new Error("FILE_REQUEST_FAILED")
          }

          autoSyncCurrentRef.current = result.requestId

          await result.completionPromise

          console.log("AUTO SYNC COMPLETED:", file.fileName)
        } catch (error) {
          console.error("AUTO SYNC FILE ERROR:", file.fileName, error)

          autoSyncFilesRef.current.delete(file.id)

          autoSyncCurrentRef.current = null

          if (error?.message === "CONNECTION_CLOSED") {
            console.log("AUTO SYNC STOPPED: CONNECTION_CLOSED")

            break
          }
        }

        await new Promise(resolve => setTimeout(resolve, 150))
      }

      console.log("=== DATABASE AUTO SYNC FINISHED ===")
    } catch (error) {
      console.error("DATABASE AUTO SYNC ERROR:", error)
    } finally {
      autoSyncStartedRef.current = false

      autoSyncCurrentRef.current = null
    }
  }, [db, isTrusted, sendDatabaseFile])

  useEffect(() => {
    syncDatabaseFilesRef.current = syncDatabaseFiles
  }, [syncDatabaseFiles])

  /* ============================================================
   * START FILE AUTO SYNC AFTER CONNECT
   * ============================================================ */

  useEffect(() => {
    if (!connectedDevice) {
      return
    }

    if (!isTrusted) {
      return
    }

    const timer = setTimeout(() => {
      if (syncDatabaseFilesRef.current) {
        syncDatabaseFilesRef.current()
      }
    }, 500)

    return () => {
      clearTimeout(timer)
    }
  }, [connectedDevice, isTrusted])

  /* ============================================================
   * START DATABASE SYNC AFTER CONNECT
   * ============================================================ */

  useEffect(() => {
    if (!connectedDevice) {
      return
    }

    if (!isTrusted) {
      return
    }

    if (databaseAutoSyncStartedRef.current) {
      return
    }

    databaseAutoSyncStartedRef.current = true

    const timer = setTimeout(() => {
      startDatabaseSync()
    }, 1000)

    return () => {
      clearTimeout(timer)
    }
  }, [connectedDevice, isTrusted, startDatabaseSync])

  /* ============================================================
   * DISCONNECT
   * ============================================================ */

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true

    autoConnectAttemptRef.current = false

    clearReconnectTimer()

    reconnectAttemptRef.current = 0

    connectionGenerationRef.current += 1

    for (const [transferId, download] of incomingDownloadsRef.current) {
      try {
        if (typeof download.pauseAsync === "function") {
          download.pauseAsync()
        }
      } catch (_) {}

      console.log("PAUSED DOWNLOAD:", transferId)
    }

    incomingDownloadsRef.current.clear()

    databaseSyncRequestRef.current = null

    databaseSyncRunningRef.current = false

    databaseAutoSyncStartedRef.current = false

    setDatabaseSyncing(false)

    autoSyncStartedRef.current = false

    autoSyncQueueRef.current = []

    autoSyncCurrentRef.current = null

    for (const [requestId, waiter] of autoSyncWaitersRef.current) {
      try {
        waiter.reject(new Error("CONNECTION_CLOSED"))
      } catch (_) {}
    }

    autoSyncWaitersRef.current.clear()

    clearDiscoveryTimer()
    clearDiscoveryRestartTimer()

    try {
      AvocatoFlow.stopDiscovery()
    } catch (error) {
      console.log("STOP DISCOVERY ERROR:", error?.message || error)
    }

    try {
      AvocatoFlow.disconnect()
    } catch (error) {
      console.log("DISCONNECT ERROR:", error?.message || error)
    }

    connectedDeviceRef.current = null

    setConnectedDevice(null)

    setIsTrusted(false)

    setConnectingId(null)

    setAutoConnecting(false)

    setIsDiscovering(false)
  }, [clearDiscoveryTimer, clearDiscoveryRestartTimer, clearReconnectTimer])

  /* ============================================================
   * FORGET PC
   * ============================================================ */

  const forgetPc = useCallback(async () => {
    Alert.alert(
      "إلغاء الاقتران",
      "هل تريد إزالة هذا الكمبيوتر من الأجهزة الموثوقة؟",
      [
        {
          text: "إلغاء",

          style: "cancel",
        },

        {
          text: "إزالة",

          style: "destructive",

          onPress: async () => {
            try {
              manualDisconnectRef.current = true
              autoConnectAttemptRef.current = false

              clearReconnectTimer()

              reconnectAttemptRef.current = 0
              await AsyncStorage.removeItem(TRUSTED_PC_KEY)

              setTrustedPc(null)

              setIsTrusted(false)

              databaseAutoSyncStartedRef.current = false

              databaseSyncRequestRef.current = null

              databaseSyncRunningRef.current = false

              setDatabaseSyncing(false)

              if (connectedDeviceRef.current) {
                try {
                  AvocatoFlow.sendMessage(
                    JSON.stringify({
                      type: "UNPAIR",

                      version: 1,

                      timestamp: Date.now(),

                      payload: {},
                    }),
                  )
                } catch (error) {
                  console.error("UNPAIR ERROR:", error)
                }
              }

              Alert.alert("تم", "تم حذف الكمبيوتر من الأجهزة الموثوقة.")
            } catch (error) {
              console.error("FORGET PC ERROR:", error)

              Alert.alert("خطأ", "تعذر حذف الكمبيوتر الموثوق.")
            }
          },
        },
      ],
    )
  }, [clearReconnectTimer])

  /* ============================================================
   * INITIAL DISCOVERY / CLEANUP
   * ============================================================ */

  useEffect(() => {
    startDiscovery()

    return () => {
      clearDiscoveryTimer()
      clearDiscoveryRestartTimer()
      clearReconnectTimer()

      reconnectAttemptRef.current = 0

      try {
        AvocatoFlow.stopDiscovery()
      } catch (_) {}

      autoSyncQueueRef.current = []

      autoSyncCurrentRef.current = null

      for (const [transferId, download] of incomingDownloadsRef.current) {
        try {
          if (typeof download.pauseAsync === "function") {
            download.pauseAsync()
          }
        } catch (_) {}

        console.log("PAUSED DOWNLOAD ON UNMOUNT:", transferId)
      }

      incomingDownloadsRef.current.clear()

      databaseSyncRequestRef.current = null

      databaseSyncRunningRef.current = false

      databaseAutoSyncStartedRef.current = false
    }
  }, [
    startDiscovery,
    clearDiscoveryTimer,
    clearDiscoveryRestartTimer,
    clearReconnectTimer,
  ])

  /* ============================================================
   * UI HELPERS
   * ============================================================ */

  const getProgress = transfer => {
    if (!transfer?.total || transfer.total <= 0) {
      return 0
    }

    return Math.min(
      100,
      Math.max(0, Math.round((transfer.transferred / transfer.total) * 100)),
    )
  }

  const formatBytes = bytes => {
    if (!bytes || bytes <= 0) {
      return "0 B"
    }

    const units = ["B", "KB", "MB", "GB", "TB"]

    const index = Math.floor(Math.log(bytes) / Math.log(1024))

    return `${(bytes / Math.pow(1024, index)).toFixed(
      index === 0 ? 0 : 1,
    )} ${units[index]}`
  }

  /* ============================================================
   * RENDER
   * ============================================================ */

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
        {/* ======================================================
          PAIR MODAL
          ====================================================== */}

        <Modal
          visible={pairConfirmVisible}
          transparent={true}
          animationType="fade"
          onRequestClose={() => {
            setPairConfirmVisible(false)

            setPairCodeInput("")

            setPairRequest(null)
          }}
        >
          <View
            style={{
              flex: 1,

              backgroundColor: "rgba(0,0,0,0.75)",

              alignItems: "center",

              justifyContent: "center",

              paddingHorizontal: 24,
            }}
          >
            <View
              style={{
                width: "100%",

                backgroundColor: "#1e293b",

                borderRadius: 18,

                padding: 20,

                borderWidth: 1,

                borderColor: "#334155",

                elevation: 8,

                shadowColor: "#000",

                shadowOffset: {
                  width: 0,
                  height: 4,
                },

                shadowOpacity: 0.3,

                shadowRadius: 10,
              }}
            >
              <Text
                style={{
                  fontSize: 20,

                  fontWeight: "800",

                  color: "#f1f5f9",

                  textAlign: "center",

                  marginBottom: 8,
                }}
              >
                رمز الاقتران
              </Text>

              <Text
                style={{
                  fontSize: 13,

                  color: "#94a3b8",

                  textAlign: "center",

                  marginBottom: 12,
                }}
              >
                أدخل رمز الاقتران الظاهر على الكمبيوتر
              </Text>

              <TextInput
                value={pairCodeInput}
                onChangeText={setPairCodeInput}
                placeholder="أدخل رمز الاقتران"
                placeholderTextColor="#64748b"
                keyboardType="number-pad"
                maxLength={6}
                autoFocus={true}
                textAlign="center"
                style={{
                  height: 50,

                  borderWidth: 1,

                  borderColor: "#334155",

                  borderRadius: 12,

                  fontSize: 20,

                  fontWeight: "700",

                  color: "#f1f5f9",

                  backgroundColor: "#0f172a",

                  marginBottom: 18,

                  paddingHorizontal: 12,
                }}
              />

              <View
                style={{
                  flexDirection: "row-reverse",

                  gap: 8,
                }}
              >
                <Pressable
                  onPress={() => {
                    setPairConfirmVisible(false)

                    setPairCodeInput("")

                    setPairRequest(null)
                  }}
                  style={{
                    flex: 1,

                    height: 48,

                    borderRadius: 12,

                    backgroundColor: "#334155",

                    alignItems: "center",

                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={{
                      color: "#cbd5e1",

                      fontSize: 14,

                      fontWeight: "800",
                    }}
                  >
                    إلغاء
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    const enteredCode = pairCodeInput.trim()

                    if (!enteredCode) {
                      Alert.alert("رمز الاقتران", "يرجى إدخال رمز الاقتران.")

                      return
                    }

                    if (enteredCode !== String(pairRequest?.code || "")) {
                      Alert.alert(
                        "رمز غير صحيح",
                        "رمز الاقتران الذي أدخلته غير صحيح.",
                      )

                      return
                    }

                    try {
                      AvocatoFlow.sendMessage(
                        JSON.stringify({
                          type: "PAIR_CONFIRM",

                          version: 1,

                          requestId: pairRequest?.requestId,

                          timestamp: Date.now(),

                          payload: {
                            requestId: pairRequest?.requestId,

                            code: enteredCode,
                          },
                        }),
                      )

                      setPairConfirmVisible(false)

                      setPairCodeInput("")

                      setPairRequest(null)
                    } catch (error) {
                      console.error("PAIR_CONFIRM ERROR:", error)

                      Alert.alert(
                        "خطأ",
                        error?.message || "تعذر تأكيد الاقتران.",
                      )
                    }
                  }}
                  style={{
                    flex: 1,

                    height: 48,

                    borderRadius: 12,

                    backgroundColor: "#4f46e5",

                    alignItems: "center",

                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={{
                      color: "#ffffff",

                      fontSize: 14,

                      fontWeight: "800",
                    }}
                  >
                    تأكيد
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* ======================================================
          HEADER
          ====================================================== */}

        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <MaterialIcons name="sync" size={40} color="#818cf8" />
          </View>

          <View style={styles.headerText}>
            <Text style={styles.title}>مزامنة الشبكه</Text>

            <Text style={styles.subtitle}>
              نقل ومزامنة البيانات مع تطبيق الكمبيوتر
            </Text>
          </View>
        </View>

        {/* ======================================================
          CONNECTION CARD
          ====================================================== */}

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>حالة الاتصال</Text>

            <View
              style={[
                styles.statusBadge,

                connectedDevice
                  ? styles.statusConnected
                  : styles.statusDisconnected,
              ]}
            >
              <View
                style={{
                  width: 8,

                  height: 8,

                  borderRadius: 4,

                  marginRight: 6,

                  backgroundColor: connectedDevice ? "#34d399" : "#f87171",
                }}
              />

              <Text style={styles.statusText}>
                {connectedDevice ? "متصل" : "غير متصل"}
              </Text>
            </View>
          </View>

          {connectedDevice ? (
            <View style={styles.connectedBox}>
              <View style={styles.deviceIcon}>
                <MaterialIcons name="computer" size={32} color="#818cf8" />
              </View>

              <View style={styles.deviceInfo}>
                <Text style={styles.deviceName}>{connectedDevice.name}</Text>

                <Text style={styles.deviceIp}>ID::[{connectedDevice.id}]</Text>
                <Text style={styles.deviceIp}>{connectedDevice.ip}</Text>

                <Text style={styles.trustedText}>
                  {isTrusted ? "✓ جهاز موثوق" : "⚠ يحتاج إلى اقتران"}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.notConnected}>
              <MaterialIcons
                name={isDiscovering ? "search" : "computer"}
                size={42}
                color="#64748b"
              />

              <Text style={styles.notConnectedText}>
                {isDiscovering
                  ? "جاري البحث عن الكمبيوتر..."
                  : "لم يتم الاتصال بأي كمبيوتر"}
              </Text>
            </View>
          )}

          {connectionError && (
            <View style={styles.errorBox}>
              <MaterialIcons name="error-outline" size={22} color="#f87171" />

              <Text style={styles.errorText}>{connectionError}</Text>
            </View>
          )}

          {connectedDevice ? (
            <View style={styles.actionsRow}>
              {!isTrusted && (
                <Pressable
                  style={[styles.primaryButton, styles.flexButton]}
                  onPress={requestPairing}
                >
                  <MaterialIcons name="link" size={20} color="#fff" />

                  <Text style={styles.primaryButtonText}>إقران الجهاز</Text>
                </Pressable>
              )}

              {isTrusted && (
                <Pressable
                  style={[styles.forgetButton, styles.flexButton]}
                  onPress={forgetPc}
                >
                  <MaterialIcons
                    name="delete-outline"
                    size={20}
                    color="#f87171"
                  />

                  <Text
                    style={{
                      color: "#f87171",

                      fontWeight: "700",

                      fontSize: 14,
                    }}
                  >
                    إلغاء الاقتران
                  </Text>
                </Pressable>
              )}

              <Pressable
                style={[styles.disconnectButton, styles.flexButton]}
                onPress={disconnect}
              >
                <MaterialIcons name="link-off" size={20} color="#fff" />

                <Text style={styles.forgetButtonText}>قطع الإتصال</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={styles.primaryButton}
              onPress={() => startDiscovery()}
            >
              {isDiscovering ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="refresh" size={21} color="#fff" />
              )}

              <Text style={styles.primaryButtonText}>
                {isDiscovering ? "جاري البحث..." : "البحث عن الكمبيوتر"}
              </Text>
            </Pressable>
          )}
        </View>

        {/* ======================================================
          DEVICES
          ====================================================== */}

        {!connectedDevice && devices.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>أجهزة الكمبيوتر</Text>

              <Text style={styles.countText}>{devices.length}</Text>
            </View>

            {devices.map(device => {
              const isConnecting = connectingId === device.id

              return (
                <Pressable
                  key={device.id}
                  style={styles.deviceRow}
                  onPress={() => handleConnect(device)}
                  disabled={Boolean(connectingId)}
                >
                  <View style={styles.deviceRowIcon}>
                    <MaterialIcons name="computer" size={26} color="#818cf8" />
                  </View>

                  <View style={styles.deviceRowInfo}>
                    <Text style={styles.deviceRowName}>
                      {device.name}-{device.id}
                    </Text>

                    <Text style={styles.deviceRowIp}>{device.ip}</Text>

                    <Text style={styles.deviceRowPort}>
                      WS:
                      {device.websocketPort}
                      {" | "}
                      HTTP:
                      {device.httpPort}
                    </Text>
                  </View>

                  {isConnecting ? (
                    <ActivityIndicator size="small" color="#818cf8" />
                  ) : (
                    <MaterialIcons
                      name="chevron-left"
                      size={28}
                      color="#64748b"
                    />
                  )}
                </Pressable>
              )
            })}
          </View>
        )}

        {databaseSyncSuccess && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: "#064e3b",
              borderWidth: 1,
              borderColor: "#047857",
              borderRadius: 13,
              padding: 13,
              marginBottom: 12,
            }}
          >
            <MaterialIcons name="check-circle" size={22} color="#34d399" />

            <Text
              style={{
                flex: 1,
                marginLeft: 8,
                fontSize: 13,
                fontWeight: "700",
                color: "#d1fae5",
              }}
            >
              تمت المزامنة بنجاح
            </Text>
          </View>
        )}

        {/* ======================================================
          TRANSFERS
          ====================================================== */}

        {isTrusted && connectedDevice && transfers.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>الملفات ({transfers.length})</Text>

              <MaterialIcons name="loop" size={22} color="#818cf8" />
            </View>

            <View style={styles.transferList}>
              {transfers
                .slice()
                .reverse()
                .map(transfer => {
                  const progress = getProgress(transfer)

                  const isIncoming = transfer.direction === "PC_TO_ANDROID"

                  return (
                    <View key={transfer.requestId} style={styles.transferItem}>
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
                          ? isIncoming
                            ? "جاري تجهيز استقبال الملف..."
                            : "في انتظار الكمبيوتر..."
                          : transfer.status === "transferring"
                            ? isIncoming
                              ? "جاري تنزيل الملف من الكمبيوتر..."
                              : progress >= 100
                                ? "اكتمل رفع الملف، في انتظار تأكيد الكمبيوتر..."
                                : "جاري النقل..."
                            : transfer.status === "completed"
                              ? isIncoming
                                ? "تم تنزيل الملف إلى الهاتف بنجاح"
                                : "تم النقل بنجاح"
                              : transfer.status === "error"
                                ? "فشل النقل"
                                : ""}
                      </Text>

                      {isIncoming && transfer.status === "transferring" && (
                        <Text
                          style={[
                            styles.transferStatus,
                            {
                              color: "#818cf8",

                              marginTop: 4,
                            },
                          ]}
                        >
                          PC → Android
                        </Text>
                      )}

                      {!isIncoming && transfer.status !== "completed" && (
                        <Text
                          style={[
                            styles.transferStatus,
                            {
                              color: "#94a3b8",

                              marginTop: 4,
                            },
                          ]}
                        >
                          Android → PC
                        </Text>
                      )}
                    </View>
                  )
                })}
            </View>
          </View>
        )}

        {/* ======================================================
          INFO
          ====================================================== */}

        <View style={styles.infoBox}>
          <MaterialIcons name="info-outline" size={22} color="#818cf8" />

          <Text style={styles.infoText}>
            يجب أن يكون الهاتف والكمبيوتر على نفس شبكة Wi-Fi أو الشبكة المحلية.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/* ==============================================================
 * STYLES (Dark Mode)
 * ============================================================== */

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

    alignItems: "center",

    justifyContent: "center",
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

  countText: {
    minWidth: 28,

    height: 28,

    borderRadius: 14,

    backgroundColor: "#312e81",

    color: "#818cf8",

    textAlign: "center",

    textAlignVertical: "center",

    fontWeight: "700",

    paddingTop: 4,
  },

  statusBadge: {
    flexDirection: "row",

    alignItems: "center",

    paddingHorizontal: 10,

    paddingVertical: 6,

    borderRadius: 20,
  },

  statusConnected: {
    backgroundColor: "#064e3b",
  },

  statusDisconnected: {
    backgroundColor: "#334155",
  },

  statusDot: {
    width: 8,

    height: 8,

    borderRadius: 4,

    marginRight: 6,
  },

  statusText: {
    fontSize: 12,

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

    alignItems: "flex-start",
  },

  deviceName: {
    fontSize: 17,

    fontWeight: "800",

    color: "#f1f5f9",
  },

  deviceIp: {
    marginTop: 3,

    fontSize: 13,

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

    marginRight: 8,

    color: "#fca5a5",

    fontSize: 13,
  },

  primaryButton: {
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

  secondaryButton: {
    minHeight: 48,

    borderRadius: 12,

    backgroundColor: "#312e81",

    borderWidth: 1,

    borderColor: "#4338ca",

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "center",

    paddingHorizontal: 14,

    gap: 7,
  },

  secondaryButtonText: {
    color: "#818cf8",

    fontSize: 14,

    fontWeight: "800",
  },

  actionsRow: {
    flexDirection: "row",

    alignItems: "center",

    gap: 8,
  },

  flexButton: {
    flex: 1,
  },

  disconnectButton: {
    width: 48,

    height: 48,

    gap: 7,

    borderRadius: 12,

    backgroundColor: "#991b1b",

    borderWidth: 1,

    flexDirection: "row",

    borderColor: "#991b1b",

    alignItems: "center",

    justifyContent: "center",
  },

  deviceRow: {
    flexDirection: "row",

    alignItems: "center",

    paddingVertical: 13,

    borderTopWidth: 1,

    borderTopColor: "#334155",
  },

  deviceRowIcon: {
    width: 46,

    height: 46,

    borderRadius: 12,

    backgroundColor: "#312e81",

    alignItems: "center",

    justifyContent: "center",

    marginRight: 12,
  },

  deviceRowInfo: {
    flex: 1,

    alignItems: "flex-start",
  },

  deviceRowName: {
    fontSize: 16,

    fontWeight: "700",

    color: "#f1f5f9",
  },

  deviceRowIp: {
    marginTop: 2,

    fontSize: 13,

    color: "#94a3b8",
  },

  deviceRowPort: {
    marginTop: 2,

    fontSize: 11,

    color: "#64748b",
  },

  trustedDescription: {
    fontSize: 13,

    lineHeight: 21,

    color: "#94a3b8",

    marginBottom: 14,
  },

  forgetButton: {
    height: 44,

    borderRadius: 11,

    backgroundColor: "#450a0a",

    borderWidth: 1,

    borderColor: "#7f1d1d",

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "center",

    gap: 7,
  },

  forgetButtonText: {
    color: "#fff",

    fontWeight: "700",

    fontSize: 14,
  },

  fileButton: {
    minHeight: 54,

    borderRadius: 13,

    backgroundColor: "#312e81",

    borderWidth: 1,

    borderColor: "#4338ca",

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "center",

    gap: 9,
  },

  fileButtonText: {
    color: "#818cf8",

    fontSize: 15,

    fontWeight: "800",
  },

  transferList: {
    marginTop: 15,
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

    alignItems: "flex-start",
  },

  transferName: {
    width: "100%",

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

  progressBackground: {
    height: 7,

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

  transferStatus: {
    marginTop: 6,

    fontSize: 11,

    color: "#94a3b8",
  },

  toolsRow: {
    flexDirection: "row",

    gap: 10,

    marginTop: 12,
  },

  toolButton: {
    flex: 1,

    minHeight: 48,

    borderRadius: 12,

    backgroundColor: "#0f172a",

    borderWidth: 1,

    borderColor: "#334155",

    alignItems: "center",

    justifyContent: "center",

    flexDirection: "row-reverse",

    gap: 7,
  },

  toolText: {
    color: "#cbd5e1",

    fontWeight: "700",

    fontSize: 13,
  },

  infoBox: {
    flexDirection: "row",

    alignItems: "center",

    backgroundColor: "#1e293b",

    borderWidth: 1,

    borderColor: "#334155",

    borderRadius: 13,

    padding: 13,

    marginTop: 2,
  },

  infoText: {
    flex: 1,

    marginLeft: 8,

    fontSize: 12,

    lineHeight: 19,

    color: "#94a3b8",
  },
})
