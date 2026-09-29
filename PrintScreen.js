import React, { useCallback, useEffect, useState } from "react"

import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"

import { MaterialIcons } from "@react-native-vector-icons/material-icons"

import * as DocumentPicker from "expo-document-picker"

import AvocatoPrint from "../modules/avocato-print/src"

const PDF_SNAP_INTERVAL = 294
const IMAGE_SNAP_INTERVAL = 294

const NETWORK_RAW_PORT = 9100

const PrintScreen = () => {
  // ===========================================================================
  // PRINT CONNECTION MODE
  // ===========================================================================

  const [connectionMode, setConnectionMode] = useState("usb")

  // ===========================================================================
  // USB PRINTER
  // ===========================================================================

  const [printers, setPrinters] = useState([])
  const [selectedPrinter, setSelectedPrinter] = useState(null)

  const [loadingPrinters, setLoadingPrinters] = useState(false)
  const [requestingPermission, setRequestingPermission] = useState(false)
  const [permissionRequestingDeviceId, setPermissionRequestingDeviceId] =
    useState(null)

  const [permissionMessage, setPermissionMessage] = useState("")
  const [permissionGranted, setPermissionGranted] = useState(false)

  // ===========================================================================
  // NETWORK PRINTER
  // ===========================================================================

  const [networkPrinters, setNetworkPrinters] = useState([])
  const [selectedNetworkPrinter, setSelectedNetworkPrinter] = useState(null)

  const [loadingNetworkPrinters, setLoadingNetworkPrinters] = useState(false)
  const [testingNetworkPrinter, setTestingNetworkPrinter] = useState(false)

  const [networkInfo, setNetworkInfo] = useState(null)

  const [networkHost, setNetworkHost] = useState("")
  const [networkPort, setNetworkPort] = useState(String(NETWORK_RAW_PORT))

  const [networkMessage, setNetworkMessage] = useState("")
  const [networkConnected, setNetworkConnected] = useState(false)

  const [inspectedNetworkPrinter, setInspectedNetworkPrinter] = useState(null)

  // ===========================================================================
  // GENERAL PRINTING
  // ===========================================================================

  const [printing, setPrinting] = useState(false)

  const [inspectedPrinter, setInspectedPrinter] = useState(null)

  // ===========================================================================
  // PDF
  // ===========================================================================

  const [selectedPdf, setSelectedPdf] = useState(null)

  const [selectingPdf, setSelectingPdf] = useState(false)

  const [pdfPageCount, setPdfPageCount] = useState(0)

  const [pdfPreviewPages, setPdfPreviewPages] = useState([])

  const [loadingPdfPreview, setLoadingPdfPreview] = useState(false)

  // zero based
  const [selectedPdfPages, setSelectedPdfPages] = useState([])

  const [pdfCopies, setPdfCopies] = useState(1)

  // ===========================================================================
  // IMAGES
  // ===========================================================================

  const [selectedImages, setSelectedImages] = useState([])

  const [selectingImages, setSelectingImages] = useState(false)

  const [imageCopies, setImageCopies] = useState(1)

  const [loadingImagePreviews, setLoadingImagePreviews] = useState(false)

  // ===========================================================================
  // MODE
  // ===========================================================================

  const [printMode, setPrintMode] = useState("pdf")

  // ===========================================================================
  // USB PRINTERS
  // ===========================================================================

  const loadPrinters = useCallback(async () => {
    try {
      setLoadingPrinters(true)

      const list = await AvocatoPrint.getUsbPrinters()

      const normalized = Array.isArray(list) ? list : []

      setPrinters(normalized)

      setSelectedPrinter(previous => {
        if (previous) {
          const same = normalized.find(
            printer => String(printer.id) === String(previous.id),
          )

          if (same) {
            return same
          }
        }

        return (
          normalized.find(printer => printer.hasPermission) ||
          normalized[0] ||
          null
        )
      })

      if (selectedPrinter) {
        const currentSelected = normalized.find(
          printer => String(printer.id) === String(selectedPrinter.id),
        )

        if (currentSelected) {
          const granted = currentSelected.hasPermission === true

          setPermissionGranted(granted)

          setPermissionMessage(
            granted ? "تم منح الصلاحية" : "الصلاحية غير ممنوحة",
          )
        }
      }
    } catch (error) {
      console.log("USB PRINTERS ERROR:", error)

      Alert.alert("الطابعات", error?.message || "تعذر قراءة طابعات USB")
    } finally {
      setLoadingPrinters(false)
    }
  }, [selectedPrinter])

  useEffect(() => {
    loadPrinters()
  }, [])

  // ===========================================================================
  // NETWORK INFO
  // ===========================================================================

  const loadNetworkInfo = useCallback(async () => {
    try {
      if (
        !AvocatoPrint ||
        typeof AvocatoPrint.getLocalNetworkInfo !== "function"
      ) {
        console.log("AvocatoPrint.getLocalNetworkInfo غير متاح")

        return null
      }

      const result = await AvocatoPrint.getLocalNetworkInfo()

      console.log("LOCAL NETWORK INFO:", result)

      setNetworkInfo(result)

      return result
    } catch (error) {
      console.log("NETWORK INFO ERROR:", error)

      setNetworkInfo(null)

      return null
    }
  }, [])

  // ===========================================================================
  // NETWORK SCAN
  // ===========================================================================

  const scanNetworkPrinters = useCallback(async () => {
    try {
      setLoadingNetworkPrinters(true)
      setNetworkMessage("جاري البحث عن طابعات الشبكة...")

      const info = await loadNetworkInfo()

      if (!info) {
        throw new Error("تعذر معرفة اتصال الشبكة الحالي.")
      }

      if (
        !AvocatoPrint ||
        typeof AvocatoPrint.scanNetworkPrinters !== "function"
      ) {
        throw new Error(
          "ميزة البحث عن طابعات الشبكة غير متاحة في النسخة الحالية من AvocatoPrint.",
        )
      }

      const result = await AvocatoPrint.scanNetworkPrinters()

      const normalized = Array.isArray(result) ? result : []

      console.log("NETWORK PRINTERS:", normalized)

      setNetworkPrinters(normalized)

      setSelectedNetworkPrinter(previous => {
        if (previous) {
          const same = normalized.find(
            printer =>
              String(printer.host) === String(previous.host) &&
              Number(printer.port || NETWORK_RAW_PORT) ===
                Number(previous.port || NETWORK_RAW_PORT),
          )

          if (same) {
            return same
          }
        }

        return normalized[0] || null
      })

      if (normalized.length > 0) {
        const first = normalized[0]

        setNetworkHost(String(first.host || first.ip || ""))

        setNetworkPort(String(first.port || NETWORK_RAW_PORT))

        setNetworkMessage(
          `تم العثور على ${normalized.length} طابعة على الشبكة.`,
        )
      } else {
        setNetworkMessage("لم يتم العثور على طابعات تستخدم منفذ RAW 9100.")
      }

      return normalized
    } catch (error) {
      console.log("NETWORK SCAN ERROR:", error)

      setNetworkPrinters([])
      setSelectedNetworkPrinter(null)

      setNetworkMessage(error?.message || "تعذر البحث عن طابعات الشبكة.")

      Alert.alert(
        "طابعات الشبكة",
        error?.message || "تعذر البحث عن طابعات الشبكة.",
      )

      return []
    } finally {
      setLoadingNetworkPrinters(false)
    }
  }, [loadNetworkInfo])

  // ===========================================================================
  // LOAD NETWORK PRINTERS WHEN NETWORK MODE IS SELECTED
  // ===========================================================================

  useEffect(() => {
    if (connectionMode !== "network") {
      return
    }

    loadNetworkInfo()
  }, [connectionMode, loadNetworkInfo])

  // ===========================================================================
  // SELECT NETWORK PRINTER
  // ===========================================================================

  const selectNetworkPrinter = useCallback(printer => {
    setSelectedNetworkPrinter(printer)

    setNetworkHost(String(printer?.host || printer?.ip || ""))

    setNetworkPort(String(printer?.port || NETWORK_RAW_PORT))

    setNetworkConnected(
      printer?.reachable === true || printer?.connected === true,
    )

    setNetworkMessage(
      printer?.reachable === true || printer?.connected === true
        ? "الطابعة متصلة بالشبكة."
        : "لم يتم اختبار اتصال الطابعة بعد.",
    )

    setInspectedNetworkPrinter(null)
  }, [])

  // ===========================================================================
  // MANUAL NETWORK PRINTER
  // ===========================================================================

  const useManualNetworkPrinter = useCallback(() => {
    const host = String(networkHost || "").trim()

    const port = Number(networkPort)

    if (!host) {
      Alert.alert("طابعة الشبكة", "يرجى إدخال عنوان IP للطابعة.")

      return
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      Alert.alert("منفذ الطابعة", "رقم المنفذ غير صحيح.")

      return
    }

    const printer = {
      id: `network-${host}-${port}`,
      host,
      ip: host,
      port,
      name: `Network Printer ${host}`,
      protocol: "RAW",
      reachable: false,
      connected: false,
    }

    setSelectedNetworkPrinter(printer)

    setNetworkConnected(false)

    setNetworkMessage("تم تحديد الطابعة يدويًا. اضغط فحص الاتصال.")

    setInspectedNetworkPrinter(null)
  }, [networkHost, networkPort])

  // ===========================================================================
  // TEST NETWORK PRINTER
  // ===========================================================================

  const testNetworkConnection = useCallback(
    async (printer = selectedNetworkPrinter) => {
      if (!printer) {
        Alert.alert("طابعة الشبكة", "يرجى اختيار طابعة أولًا.")

        return false
      }

      const host = String(printer.host || printer.ip || "").trim()

      const port = Number(printer.port || networkPort || NETWORK_RAW_PORT)

      if (!host) {
        Alert.alert("طابعة الشبكة", "عنوان IP للطابعة غير موجود.")

        return false
      }

      try {
        setTestingNetworkPrinter(true)

        setNetworkMessage("جاري فحص اتصال الطابعة...")

        if (typeof AvocatoPrint.testNetworkPrinter !== "function") {
          throw new Error("ميزة فحص طابعة الشبكة غير متاحة في النسخة الحالية.")
        }

        const result = await AvocatoPrint.testNetworkPrinter(host, port)

        console.log("NETWORK TEST:", result)

        const connected =
          result?.reachable === true ||
          result?.connected === true ||
          result?.success === true

        setNetworkConnected(connected)

        const updatedPrinter = {
          ...printer,
          host,
          ip: host,
          port,
          reachable: connected,
          connected: connected,
          latencyMs: result?.latencyMs,
        }

        setSelectedNetworkPrinter(updatedPrinter)

        setNetworkPrinters(previous => {
          const exists = previous.some(
            item =>
              String(item.host || item.ip || "") === host &&
              Number(item.port || NETWORK_RAW_PORT) === port,
          )

          if (!exists) {
            return [...previous, updatedPrinter]
          }

          return previous.map(item => {
            const same =
              String(item.host || item.ip || "") === host &&
              Number(item.port || NETWORK_RAW_PORT) === port

            return same
              ? {
                  ...item,
                  ...updatedPrinter,
                }
              : item
          })
        })

        setNetworkMessage(
          connected
            ? `تم الاتصال بالطابعة ${host}:${port}${
                result?.latencyMs != null ? ` • ${result.latencyMs} ms` : ""
              }`
            : "تعذر الاتصال بالطابعة.",
        )

        return connected
      } catch (error) {
        console.log("NETWORK CONNECTION ERROR:", error)

        setNetworkConnected(false)

        setNetworkMessage(error?.message || "تعذر الاتصال بالطابعة.")

        Alert.alert(
          "فحص اتصال الطابعة",
          error?.message || "تعذر الاتصال بالطابعة.",
        )

        return false
      } finally {
        setTestingNetworkPrinter(false)
      }
    },
    [selectedNetworkPrinter, networkPort],
  )

  // ===========================================================================
  // NETWORK INSPECT
  // ===========================================================================

  const inspectNetworkPrinter = useCallback(async () => {
    if (!selectedNetworkPrinter) {
      Alert.alert("طابعة الشبكة", "يرجى اختيار طابعة أولًا.")

      return
    }

    const host = String(
      selectedNetworkPrinter.host || selectedNetworkPrinter.ip || "",
    ).trim()

    const port = Number(
      selectedNetworkPrinter.port || networkPort || NETWORK_RAW_PORT,
    )

    try {
      if (typeof AvocatoPrint.inspectNetworkPrinter !== "function") {
        throw new Error("ميزة فحص طابعة الشبكة غير متاحة في النسخة الحالية.")
      }

      const result = await AvocatoPrint.inspectNetworkPrinter(host, port)

      console.log("NETWORK INSPECT:", result)

      setInspectedNetworkPrinter(result)
    } catch (error) {
      console.log("NETWORK INSPECT ERROR:", error)

      Alert.alert("فحص الطابعة", error?.message || "تعذر فحص طابعة الشبكة.")
    }
  }, [selectedNetworkPrinter, networkPort])

  // ===========================================================================
  // NETWORK TEST PRINT
  // ===========================================================================

  const printNetworkTest = useCallback(async () => {
    if (!selectedNetworkPrinter) {
      Alert.alert("طابعة الشبكة", "يرجى اختيار طابعة أولًا.")

      return
    }

    const host = String(
      selectedNetworkPrinter.host || selectedNetworkPrinter.ip || "",
    ).trim()

    const port = Number(
      selectedNetworkPrinter.port || networkPort || NETWORK_RAW_PORT,
    )

    if (!host) {
      Alert.alert("طابعة الشبكة", "عنوان IP للطابعة غير موجود.")

      return
    }

    try {
      setPrinting(true)

      const connected = await testNetworkConnection(selectedNetworkPrinter)

      if (!connected) {
        return
      }

      if (typeof AvocatoPrint.printNetworkTest !== "function") {
        throw new Error(
          "طباعة الشبكة غير متاحة في النسخة الحالية من AvocatoPrint.",
        )
      }

      const result = await AvocatoPrint.printNetworkTest(host, port)

      console.log("NETWORK TEST PRINT RESULT:", result)

      Alert.alert("نجاح", "تم إرسال صفحة الاختبار إلى طابعة الشبكة.")
    } catch (error) {
      console.log("NETWORK TEST PRINT ERROR:", error)

      Alert.alert(
        "خطأ في الطباعة",
        error?.message || "تعذر طباعة صفحة الاختبار عبر الشبكة.",
      )
    } finally {
      setPrinting(false)
    }
  }, [selectedNetworkPrinter, networkPort, testNetworkConnection])

  // ===========================================================================
  // USB PERMISSION REFRESH
  // ===========================================================================

  const refreshPrinterPermission = useCallback(async deviceId => {
    try {
      const list = await AvocatoPrint.getUsbPrinters()

      const normalized = Array.isArray(list) ? list : []

      setPrinters(normalized)

      const updatedPrinter = normalized.find(
        printer => String(printer.id) === String(deviceId),
      )

      if (updatedPrinter) {
        setSelectedPrinter(previous => {
          if (previous && String(previous.id) === String(updatedPrinter.id)) {
            return {
              ...previous,
              ...updatedPrinter,
            }
          }

          return updatedPrinter
        })

        const granted = updatedPrinter.hasPermission === true

        setPermissionGranted(granted)

        setPermissionMessage(
          granted ? "تم منح الصلاحية" : "الصلاحية غير ممنوحة",
        )

        return updatedPrinter
      }

      return null
    } catch (error) {
      console.log("REFRESH USB PERMISSION ERROR:", error)

      return null
    }
  }, [])

  // ===========================================================================
  // USB PERMISSION EVENT
  // ===========================================================================

  useEffect(() => {
    let subscription = null

    try {
      if (AvocatoPrint && typeof AvocatoPrint.addListener === "function") {
        subscription = AvocatoPrint.addListener(
          "onUsbPermissionResult",
          async event => {
            console.log("USB PERMISSION EVENT:", event)

            const deviceId = String(event?.deviceId ?? "")

            const granted = event?.granted === true

            setPermissionGranted(granted)

            setPermissionMessage(
              granted ? "تم منح الصلاحية" : "لم يتم منح الصلاحية",
            )

            setRequestingPermission(false)

            setPermissionRequestingDeviceId(null)

            if (deviceId) {
              const updated = await refreshPrinterPermission(deviceId)

              if (updated) {
                const finalGranted = updated.hasPermission === true

                setPermissionGranted(finalGranted)

                setPermissionMessage(
                  finalGranted ? "تم منح الصلاحية" : "الصلاحية غير ممنوحة",
                )
              }
            }

            if (granted) {
              Alert.alert(
                "تم منح الصلاحية",
                "تم السماح للتطبيق باستخدام الطابعة.",
              )
            } else {
              Alert.alert(
                "صلاحية الطابعة",
                "لم يتم منح التطبيق صلاحية استخدام الطابعة.",
              )
            }
          },
        )
      }
    } catch (error) {
      console.log("USB PERMISSION LISTENER ERROR:", error)
    }

    return () => {
      try {
        subscription?.remove?.()
      } catch (error) {
        console.log("USB PERMISSION LISTENER REMOVE ERROR:", error)
      }
    }
  }, [refreshPrinterPermission])

  // ===========================================================================
  // USB PERMISSION
  // ===========================================================================

  const ensurePrinterPermission = useCallback(
    async (printer = selectedPrinter) => {
      if (!printer) {
        Alert.alert("الطابعة", "يرجى اختيار طابعة أولًا")

        return false
      }

      const deviceId = Number(printer.id)

      if (printer.hasPermission === true) {
        setPermissionGranted(true)

        setPermissionMessage("تم منح الصلاحية")

        return true
      }

      try {
        setRequestingPermission(true)

        setPermissionRequestingDeviceId(deviceId)

        setPermissionGranted(false)

        setPermissionMessage("جاري طلب صلاحية الطابعة...")

        console.log("REQUEST USB PERMISSION:", deviceId)

        const result = await AvocatoPrint.requestUsbPermission(deviceId)

        console.log("USB PERMISSION REQUEST RESULT:", result)

        if (result?.granted === true) {
          setPermissionGranted(true)

          setPermissionMessage("تم منح الصلاحية")

          const updated = await refreshPrinterPermission(deviceId)

          if (updated?.hasPermission === true) {
            setRequestingPermission(false)

            setPermissionRequestingDeviceId(null)

            return true
          }
        }

        for (let attempt = 0; attempt < 12; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 500))

          const updated = await refreshPrinterPermission(deviceId)

          if (updated?.hasPermission === true) {
            console.log("USB PERMISSION GRANTED AFTER POLLING:", attempt + 1)

            setPermissionGranted(true)

            setPermissionMessage("تم منح الصلاحية")

            setRequestingPermission(false)

            setPermissionRequestingDeviceId(null)

            return true
          }
        }

        setPermissionGranted(false)

        setPermissionMessage("الصلاحية غير ممنوحة")

        Alert.alert(
          "صلاحية الطابعة",
          "لم يتم منح التطبيق صلاحية استخدام الطابعة.\n\nإذا ظهرت نافذة Android، اضغط سماح ثم أعد المحاولة.",
        )

        return false
      } catch (error) {
        console.log("USB PERMISSION ERROR:", error)

        setPermissionGranted(false)

        setPermissionMessage("تعذر الحصول على الصلاحية")

        Alert.alert(
          "صلاحية الطابعة",
          error?.message || "تعذر طلب صلاحية استخدام الطابعة.",
        )

        return false
      } finally {
        setRequestingPermission(false)

        setPermissionRequestingDeviceId(null)
      }
    },
    [selectedPrinter, refreshPrinterPermission],
  )

  const requestPermission = useCallback(
    async printer => {
      await ensurePrinterPermission(printer)
    },
    [ensurePrinterPermission],
  )

  // ===========================================================================
  // SELECT USB PRINTER
  // ===========================================================================

  const selectPrinter = useCallback(printer => {
    setSelectedPrinter(printer)

    const granted = printer?.hasPermission === true

    setPermissionGranted(granted)

    setPermissionMessage(granted ? "تم منح الصلاحية" : "الصلاحية غير ممنوحة")

    setInspectedPrinter(null)
  }, [])

  // ===========================================================================
  // USB TEST
  // ===========================================================================

  const printUsbTest = useCallback(async () => {
    if (!selectedPrinter) {
      Alert.alert("الطابعة", "يرجى اختيار طابعة أولًا.")

      return
    }

    const permission = await ensurePrinterPermission(selectedPrinter)

    if (!permission) {
      return
    }

    try {
      setPrinting(true)

      const result = await AvocatoPrint.printUsbTest(Number(selectedPrinter.id))

      console.log("USB TEST PRINT RESULT:", result)

      Alert.alert("نجاح", "تم إرسال صفحة الاختبار إلى الطابعة.")
    } catch (error) {
      console.log("USB TEST PRINT ERROR:", error)

      Alert.alert(
        "خطأ في الطباعة",
        error?.message || "تعذر طباعة صفحة الاختبار.",
      )
    } finally {
      setPrinting(false)
    }
  }, [selectedPrinter, ensurePrinterPermission])

  // ===========================================================================
  // INSPECT USB PRINTER
  // ===========================================================================

  const inspectPrinter = useCallback(async () => {
    if (!selectedPrinter) {
      Alert.alert("الطابعة", "يرجى اختيار طابعة أولًا.")

      return
    }

    try {
      const result = await AvocatoPrint.inspectUsbPrinter(
        Number(selectedPrinter.id),
      )

      console.log("USB INSPECT:", result)

      setInspectedPrinter(result)
    } catch (error) {
      console.log("USB INSPECT ERROR:", error)

      Alert.alert("فحص الطابعة", error?.message || "تعذر فحص الطابعة.")
    }
  }, [selectedPrinter])

  // ===========================================================================
  // PDF PICKER
  // ===========================================================================

  const loadPdfPreview = useCallback(async uri => {
    try {
      setLoadingPdfPreview(true)

      setPdfPageCount(0)

      setPdfPreviewPages([])

      setSelectedPdfPages([])

      const count = await AvocatoPrint.getPdfPageCount(uri)

      const normalizedCount = Number(count) || 0

      setPdfPageCount(normalizedCount)

      if (normalizedCount <= 0) {
        return
      }

      const pages = []

      for (let pageIndex = 0; pageIndex < normalizedCount; pageIndex++) {
        try {
          const result = await AvocatoPrint.renderPdfPagePreview(uri, pageIndex)

          const previewUri = typeof result === "string" ? result : result?.uri

          if (!previewUri) {
            throw new Error(`تعذر إنشاء معاينة الصفحة ${pageIndex + 1}`)
          }

          pages.push({
            pageIndex,
            pageNumber: pageIndex + 1,
            uri: previewUri,
            width: result?.width || 0,
            height: result?.height || 0,
          })

          setPdfPreviewPages([...pages])
        } catch (pageError) {
          console.log(`PDF PAGE ${pageIndex + 1} PREVIEW ERROR:`, pageError)
        }
      }
    } catch (error) {
      console.log("PDF PREVIEW ERROR:", error)

      setPdfPageCount(0)

      setPdfPreviewPages([])

      setSelectedPdfPages([])

      Alert.alert("معاينة PDF", error?.message || "تعذر إنشاء معاينة ملف PDF.")
    } finally {
      setLoadingPdfPreview(false)
    }
  }, [])

  const pickPdf = useCallback(async () => {
    try {
      setSelectingPdf(true)

      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        multiple: false,
        copyToCacheDirectory: true,
      })

      if (result.canceled) {
        return
      }

      const asset = result.assets?.[0]

      if (!asset?.uri) {
        return
      }

      const pdf = {
        uri: asset.uri,
        name: asset.name || "document.pdf",
        size: asset.size || 0,
        mimeType: asset.mimeType || "application/pdf",
      }

      setSelectedPdf(pdf)

      setPdfPageCount(0)

      setPdfPreviewPages([])

      setSelectedPdfPages([])

      setPdfCopies(1)

      await loadPdfPreview(asset.uri)
    } catch (error) {
      console.log("PICK PDF ERROR:", error)

      Alert.alert("اختيار PDF", error?.message || "تعذر اختيار ملف PDF.")
    } finally {
      setSelectingPdf(false)
    }
  }, [loadPdfPreview])

  // ===========================================================================
  // PDF PAGE SELECTION
  // ===========================================================================

  const togglePdfPage = useCallback(pageIndex => {
    setSelectedPdfPages(previous => {
      if (previous.includes(pageIndex)) {
        return previous
          .filter(index => index !== pageIndex)
          .sort((a, b) => a - b)
      }

      return [...previous, pageIndex].sort((a, b) => a - b)
    })
  }, [])

  const selectAllPdfPages = useCallback(() => {
    setSelectedPdfPages(pdfPreviewPages.map(page => page.pageIndex))
  }, [pdfPreviewPages])

  const clearSelectedPdfPages = useCallback(() => {
    setSelectedPdfPages([])
  }, [])

  const isPdfPageSelected = useCallback(
    pageIndex => selectedPdfPages.includes(pageIndex),
    [selectedPdfPages],
  )

  // ===========================================================================
  // PDF COPIES
  // ===========================================================================

  const increasePdfCopies = useCallback(() => {
    setPdfCopies(value => Math.min(99, value + 1))
  }, [])

  const decreasePdfCopies = useCallback(() => {
    setPdfCopies(value => Math.max(1, value - 1))
  }, [])

  // ===========================================================================
  // PDF PRINT
  // ===========================================================================

  const printPdf = useCallback(async () => {
    if (connectionMode === "usb") {
      if (!selectedPrinter) {
        Alert.alert("الطابعة", "يرجى اختيار طابعة USB أولًا.")

        return
      }
    } else {
      if (!selectedNetworkPrinter) {
        Alert.alert("طابعة الشبكة", "يرجى اختيار طابعة شبكة أولًا.")

        return
      }
    }

    if (!selectedPdf?.uri) {
      Alert.alert("PDF", "يرجى اختيار ملف PDF أولًا.")

      return
    }

    if (selectedPdfPages.length === 0) {
      Alert.alert(
        "تحديد الصفحات",
        "يرجى الضغط على صفحات PDF التي تريد طباعتها أولًا.",
      )

      return
    }

    if (pdfCopies < 1) {
      Alert.alert("عدد النسخ", "عدد النسخ يجب أن يكون 1 على الأقل.")

      return
    }

    try {
      setPrinting(true)

      const pages = [...selectedPdfPages].sort((a, b) => a - b)

      console.log("PRINT PDF PAGES:", pages)

      console.log("PDF COPIES:", pdfCopies)

      let result

      if (connectionMode === "usb") {
        const permission = await ensurePrinterPermission(selectedPrinter)

        if (!permission) {
          return
        }

        result = await AvocatoPrint.printUsbPdfPages(
          Number(selectedPrinter.id),
          selectedPdf.uri,
          pages,
          Number(pdfCopies),
        )
      } else {
        const host = String(
          selectedNetworkPrinter.host || selectedNetworkPrinter.ip || "",
        ).trim()

        const port = Number(
          selectedNetworkPrinter.port || networkPort || NETWORK_RAW_PORT,
        )

        if (!host) {
          throw new Error("عنوان IP للطابعة غير موجود.")
        }

        if (typeof AvocatoPrint.printNetworkPdfPages !== "function") {
          throw new Error("طباعة PDF عبر الشبكة غير متاحة في النسخة الحالية.")
        }

        const connected = await testNetworkConnection(selectedNetworkPrinter)

        if (!connected) {
          return
        }

        result = await AvocatoPrint.printNetworkPdfPages(
          host,
          port,
          selectedPdf.uri,
          pages,
          Number(pdfCopies),
        )
      }

      console.log("PDF PRINT RESULT:", result)

      const pagesCount = pages.length * pdfCopies

      Alert.alert(
        "تمت الطباعة",
        `تم إرسال ${pagesCount} صفحة إلى الطابعة.\n\nالصفحات المحددة: ${pages.length}\nعدد النسخ: ${pdfCopies}`,
      )
    } catch (error) {
      console.log("PDF PRINT ERROR:", error)

      Alert.alert("خطأ في طباعة PDF", error?.message || "تعذر طباعة ملف PDF.")
    } finally {
      setPrinting(false)
    }
  }, [
    connectionMode,
    selectedPrinter,
    selectedNetworkPrinter,
    selectedPdf,
    selectedPdfPages,
    pdfCopies,
    networkPort,
    ensurePrinterPermission,
    testNetworkConnection,
  ])

  // ===========================================================================
  // IMAGE PICKER
  // ===========================================================================

  const pickImages = useCallback(async () => {
    try {
      setSelectingImages(true)

      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
        multiple: true,
        copyToCacheDirectory: true,
      })

      if (result.canceled) {
        return
      }

      const assets = result.assets || []

      if (assets.length === 0) {
        return
      }

      const images = assets
        .filter(asset => asset?.uri)
        .map((asset, index) => ({
          id: `${Date.now()}-${index}-${asset.uri}`,
          uri: asset.uri,
          previewUri: asset.uri,
          name: asset.name || `الصورة ${index + 1}`,
          size: asset.size || 0,
          mimeType: asset.mimeType || "image/jpeg",
          width: asset.width || 0,
          height: asset.height || 0,
        }))

      setSelectedImages(images)
    } catch (error) {
      console.log("PICK IMAGES ERROR:", error)

      Alert.alert("اختيار الصور", error?.message || "تعذر اختيار الصور.")
    } finally {
      setSelectingImages(false)
    }
  }, [])

  // ===========================================================================
  // IMAGE PREVIEWS
  // ===========================================================================

  useEffect(() => {
    let cancelled = false

    const renderPreviews = async () => {
      if (selectedImages.length === 0) {
        setLoadingImagePreviews(false)

        return
      }

      try {
        setLoadingImagePreviews(true)

        const results = []

        for (let index = 0; index < selectedImages.length; index++) {
          const image = selectedImages[index]

          try {
            const result = await AvocatoPrint.renderImagePreview(image.uri)

            const previewUri = typeof result === "string" ? result : result?.uri

            results.push({
              ...image,
              previewUri: previewUri || image.uri,
              width: result?.width || image.width || 0,
              height: result?.height || image.height || 0,
            })
          } catch (error) {
            console.log("IMAGE PREVIEW ERROR:", error)

            results.push(image)
          }

          if (!cancelled) {
            setSelectedImages([
              ...results,
              ...selectedImages.slice(results.length),
            ])
          }
        }
      } finally {
        if (!cancelled) {
          setLoadingImagePreviews(false)
        }
      }
    }

    renderPreviews()

    return () => {
      cancelled = true
    }
  }, [selectedImages.length])

  // ===========================================================================
  // IMAGE REMOVE
  // ===========================================================================

  const removeImage = useCallback(index => {
    setSelectedImages(previous =>
      previous.filter((_, itemIndex) => itemIndex !== index),
    )
  }, [])

  const clearImages = useCallback(() => {
    setSelectedImages([])
  }, [])

  // ===========================================================================
  // IMAGE COPIES
  // ===========================================================================

  const increaseCopies = useCallback(() => {
    setImageCopies(value => Math.min(99, value + 1))
  }, [])

  const decreaseCopies = useCallback(() => {
    setImageCopies(value => Math.max(1, value - 1))
  }, [])

  // ===========================================================================
  // IMAGE PRINT
  // ===========================================================================

  const printImages = useCallback(async () => {
    if (connectionMode === "usb") {
      if (!selectedPrinter) {
        Alert.alert("الطابعة", "يرجى اختيار طابعة USB أولًا.")

        return
      }
    } else {
      if (!selectedNetworkPrinter) {
        Alert.alert("طابعة الشبكة", "يرجى اختيار طابعة شبكة أولًا.")

        return
      }
    }

    if (selectedImages.length === 0) {
      Alert.alert("الصور", "يرجى اختيار صورة واحدة على الأقل.")

      return
    }

    try {
      setPrinting(true)

      const uris = selectedImages.map(image => image.uri)

      let result

      if (connectionMode === "usb") {
        const permission = await ensurePrinterPermission(selectedPrinter)

        if (!permission) {
          return
        }

        result = await AvocatoPrint.printUsbImages(
          Number(selectedPrinter.id),
          uris,
          Number(imageCopies),
        )
      } else {
        const host = String(
          selectedNetworkPrinter.host || selectedNetworkPrinter.ip || "",
        ).trim()

        const port = Number(
          selectedNetworkPrinter.port || networkPort || NETWORK_RAW_PORT,
        )

        if (!host) {
          throw new Error("عنوان IP للطابعة غير موجود.")
        }

        if (typeof AvocatoPrint.printNetworkImages !== "function") {
          throw new Error("طباعة الصور عبر الشبكة غير متاحة في النسخة الحالية.")
        }

        const connected = await testNetworkConnection(selectedNetworkPrinter)

        if (!connected) {
          return
        }

        result = await AvocatoPrint.printNetworkImages(
          host,
          port,
          uris,
          Number(imageCopies),
        )
      }

      console.log("IMAGE PRINT RESULT:", result)

      const total = selectedImages.length * imageCopies

      Alert.alert(
        "تمت الطباعة",
        `تم إرسال ${total} صفحة إلى الطابعة.\n\nعدد الصور: ${selectedImages.length}\nعدد النسخ: ${imageCopies}`,
      )
    } catch (error) {
      console.log("IMAGE PRINT ERROR:", error)

      Alert.alert("خطأ في الطباعة", error?.message || "تعذر طباعة الصور.")
    } finally {
      setPrinting(false)
    }
  }, [
    connectionMode,
    selectedPrinter,
    selectedNetworkPrinter,
    selectedImages,
    imageCopies,
    networkPort,
    ensurePrinterPermission,
    testNetworkConnection,
  ])

  // ===========================================================================
  // CALCULATIONS
  // ===========================================================================

  const pdfSelectedCount = selectedPdfPages.length

  const pdfTotalPrintPages = pdfSelectedCount * pdfCopies

  const imageTotalPrintPages = selectedImages.length * imageCopies

  // ===========================================================================
  // RENDER
  // ===========================================================================

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ================================================================= */}
        {/* HEADER */}
        {/* ================================================================= */}

        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <MaterialIcons name="print" size={27} color="#60A5FA" />
          </View>

          <View style={styles.headerTextContainer}>
            <Text style={styles.headerTitle}>الطباعة</Text>

            <Text style={styles.headerSubtitle}>
              طباعة ملفات PDF والصور عبر USB أو الشبكة
            </Text>
          </View>
        </View>

        {/* ================================================================= */}
        {/* CONNECTION MODE */}
        {/* ================================================================= */}

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <MaterialIcons
                name="settings-input-antenna"
                size={23}
                color="#60A5FA"
              />
            </View>

            <View style={styles.sectionHeaderText}>
              <Text style={styles.sectionTitle}>طريقة الاتصال</Text>

              <Text style={styles.sectionSubtitle}>
                اختر طريقة الاتصال بالطابعة
              </Text>
            </View>
          </View>

          <View style={styles.connectionSwitcher}>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.connectionButton,
                connectionMode === "usb" && styles.connectionButtonActive,
              ]}
              onPress={() => setConnectionMode("usb")}
            >
              <MaterialIcons
                name="usb"
                size={22}
                color={connectionMode === "usb" ? "#FFFFFF" : "#94A3B8"}
              />

              <Text
                style={[
                  styles.connectionButtonText,
                  connectionMode === "usb" && styles.connectionButtonTextActive,
                ]}
              >
                USB
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.connectionButton,
                connectionMode === "network" && styles.connectionButtonActive,
              ]}
              onPress={() => setConnectionMode("network")}
            >
              <MaterialIcons
                name="wifi"
                size={22}
                color={connectionMode === "network" ? "#FFFFFF" : "#94A3B8"}
              />

              <Text
                style={[
                  styles.connectionButtonText,
                  connectionMode === "network" &&
                    styles.connectionButtonTextActive,
                ]}
              >
                الشبكة
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ================================================================= */}
        {/* USB PRINTERS */}
        {/* ================================================================= */}

        {connectionMode === "usb" && (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <MaterialIcons name="print" size={24} color="#60A5FA" />
              </View>

              <View style={styles.sectionHeaderText}>
                <Text style={styles.sectionTitle}>طابعة USB</Text>

                <Text style={styles.sectionSubtitle}>
                  اختر الطابعة المتصلة بالجهاز
                </Text>
              </View>

              <TouchableOpacity
                activeOpacity={0.8}
                style={styles.iconButton}
                onPress={loadPrinters}
                disabled={loadingPrinters}
              >
                {loadingPrinters ? (
                  <ActivityIndicator size="small" color="#60A5FA" />
                ) : (
                  <MaterialIcons name="refresh" size={22} color="#60A5FA" />
                )}
              </TouchableOpacity>
            </View>

            {printers.length === 0 ? (
              <View style={styles.emptyBox}>
                <MaterialIcons
                  name="print-disabled"
                  size={42}
                  color="#475569"
                />

                <Text style={styles.emptyText}>لا توجد طابعة USB متصلة</Text>
              </View>
            ) : (
              printers.map(printer => {
                const selected =
                  String(selectedPrinter?.id) === String(printer.id)

                return (
                  <TouchableOpacity
                    key={String(printer.id)}
                    activeOpacity={0.85}
                    style={[
                      styles.printerItem,
                      selected && styles.printerItemSelected,
                    ]}
                    onPress={() => selectPrinter(printer)}
                  >
                    <View style={styles.printerIcon}>
                      <MaterialIcons
                        name="print"
                        size={23}
                        color={selected ? "#60A5FA" : "#64748B"}
                      />
                    </View>

                    <View style={styles.printerInfo}>
                      <Text style={styles.printerName} numberOfLines={1}>
                        {printer.name || "USB Printer"}
                      </Text>

                      <Text style={styles.printerDetails}>
                        {printer.manufacturer || "USB"} • VID {printer.vendorId}{" "}
                        • PID {printer.productId}
                      </Text>

                      {selected && (
                        <View
                          style={[
                            styles.permissionStatus,
                            printer.hasPermission
                              ? styles.permissionStatusGranted
                              : styles.permissionStatusDenied,
                          ]}
                        >
                          <MaterialIcons
                            name={
                              printer.hasPermission
                                ? "verified"
                                : "lock-outline"
                            }
                            size={14}
                            color={
                              printer.hasPermission ? "#4ADE80" : "#FBBF24"
                            }
                          />

                          <Text
                            style={[
                              styles.permissionStatusText,
                              printer.hasPermission
                                ? styles.permissionStatusTextGranted
                                : styles.permissionStatusTextDenied,
                            ]}
                          >
                            {printer.hasPermission
                              ? "تم منح الصلاحية"
                              : "الصلاحية غير ممنوحة"}
                          </Text>
                        </View>
                      )}
                    </View>

                    {printer.hasPermission ? (
                      <View style={styles.permissionBadge}>
                        <MaterialIcons
                          name="check-circle"
                          size={14}
                          color="#4ADE80"
                        />

                        <Text style={styles.permissionText}>مسموح</Text>
                      </View>
                    ) : (
                      <MaterialIcons
                        name="lock-outline"
                        size={20}
                        color="#F59E0B"
                      />
                    )}
                  </TouchableOpacity>
                )
              })
            )}

            {selectedPrinter && (
              <View
                style={[
                  styles.permissionLargeBox,
                  permissionGranted
                    ? styles.permissionLargeBoxGranted
                    : styles.permissionLargeBoxDenied,
                ]}
              >
                <View style={styles.permissionLargeIcon}>
                  <MaterialIcons
                    name={
                      requestingPermission
                        ? "hourglass-top"
                        : permissionGranted
                          ? "verified-user"
                          : "lock-outline"
                    }
                    size={24}
                    color={
                      requestingPermission
                        ? "#60A5FA"
                        : permissionGranted
                          ? "#4ADE80"
                          : "#FBBF24"
                    }
                  />
                </View>

                <View style={styles.permissionLargeInfo}>
                  <Text style={styles.permissionLargeTitle}>
                    حالة صلاحية الطابعة
                  </Text>

                  <Text
                    style={[
                      styles.permissionLargeText,
                      permissionGranted
                        ? styles.permissionLargeTextGranted
                        : styles.permissionLargeTextDenied,
                    ]}
                  >
                    {requestingPermission
                      ? "جاري انتظار موافقة Android..."
                      : permissionMessage ||
                        (permissionGranted
                          ? "تم منح الصلاحية"
                          : "الصلاحية غير ممنوحة")}
                  </Text>
                </View>
              </View>
            )}

            {selectedPrinter && !selectedPrinter.hasPermission && (
              <TouchableOpacity
                activeOpacity={0.85}
                style={[
                  styles.secondaryButton,
                  requestingPermission && styles.disabledButton,
                ]}
                onPress={() => requestPermission(selectedPrinter)}
                disabled={requestingPermission}
              >
                {requestingPermission ? (
                  <ActivityIndicator size="small" color="#60A5FA" />
                ) : (
                  <MaterialIcons name="lock-open" size={21} color="#60A5FA" />
                )}

                <Text style={styles.secondaryButtonText}>
                  {requestingPermission
                    ? "جاري طلب الصلاحية..."
                    : "منح صلاحية الطابعة"}
                </Text>
              </TouchableOpacity>
            )}

            {selectedPrinter && selectedPrinter.hasPermission && (
              <View style={styles.permissionHintGranted}>
                <MaterialIcons name="check-circle" size={17} color="#4ADE80" />

                <Text style={styles.permissionHintGrantedText}>
                  التطبيق لديه صلاحية استخدام هذه الطابعة
                </Text>
              </View>
            )}

            {selectedPrinter && (
              <>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[
                    styles.outlineButton,
                    printing && styles.disabledButton,
                  ]}
                  onPress={printUsbTest}
                  disabled={printing}
                >
                  {printing ? (
                    <ActivityIndicator size="small" color="#94A3B8" />
                  ) : (
                    <MaterialIcons
                      name="description"
                      size={20}
                      color="#94A3B8"
                    />
                  )}

                  <Text style={styles.outlineButtonText}>
                    طباعة صفحة اختبار USB
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  style={styles.outlineButton}
                  onPress={inspectPrinter}
                >
                  <MaterialIcons
                    name="info-outline"
                    size={20}
                    color="#94A3B8"
                  />

                  <Text style={styles.outlineButtonText}>
                    فحص اتصال الطابعة
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* NETWORK PRINTERS */}
        {/* ================================================================= */}

        {connectionMode === "network" && (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <MaterialIcons name="wifi" size={24} color="#60A5FA" />
              </View>

              <View style={styles.sectionHeaderText}>
                <Text style={styles.sectionTitle}>طابعة الشبكة</Text>

                <Text style={styles.sectionSubtitle}>
                  LAN / Wi-Fi • RAW / PCL
                </Text>
              </View>

              <TouchableOpacity
                activeOpacity={0.8}
                style={styles.iconButton}
                onPress={scanNetworkPrinters}
                disabled={loadingNetworkPrinters}
              >
                {loadingNetworkPrinters ? (
                  <ActivityIndicator size="small" color="#60A5FA" />
                ) : (
                  <MaterialIcons name="refresh" size={22} color="#60A5FA" />
                )}
              </TouchableOpacity>
            </View>

            {/* ------------------------------------------------------------- */}
            {/* LOCAL NETWORK INFO */}
            {/* ------------------------------------------------------------- */}

            {networkInfo && (
              <View style={styles.networkInfoBox}>
                <View style={styles.networkInfoRow}>
                  <Text style={styles.networkInfoLabel}>عنوان الجهاز</Text>

                  <Text style={styles.networkInfoValue}>
                    {networkInfo.ip || "-"}
                  </Text>
                </View>

                <View style={styles.networkInfoRow}>
                  <Text style={styles.networkInfoLabel}>الشبكة</Text>

                  <Text style={styles.networkInfoValue}>
                    {networkInfo.subnetPrefix || "-"}
                  </Text>
                </View>

                <View
                  style={[
                    styles.networkInfoRow,
                    {
                      borderBottomWidth: 0,
                    },
                  ]}
                >
                  <Text style={styles.networkInfoLabel}>المنفذ</Text>

                  <Text style={styles.networkInfoValue}>
                    RAW {NETWORK_RAW_PORT}
                  </Text>
                </View>
              </View>
            )}

            {/* ------------------------------------------------------------- */}
            {/* SCAN */}
            {/* ------------------------------------------------------------- */}

            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.primaryButton,
                loadingNetworkPrinters && styles.disabledButton,
              ]}
              onPress={scanNetworkPrinters}
              disabled={loadingNetworkPrinters}
            >
              {loadingNetworkPrinters ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <MaterialIcons name="wifi-find" size={22} color="#FFFFFF" />
              )}

              <Text style={styles.primaryButtonText}>
                {loadingNetworkPrinters
                  ? "جاري البحث..."
                  : "البحث عن طابعات الشبكة"}
              </Text>
            </TouchableOpacity>

            {/* ------------------------------------------------------------- */}
            {/* NETWORK LIST */}
            {/* ------------------------------------------------------------- */}

            {networkPrinters.length > 0 && (
              <View style={styles.networkPrintersContainer}>
                <Text style={styles.networkListTitle}>الطابعات المكتشفة</Text>

                {networkPrinters.map((printer, index) => {
                  const host = printer.host || printer.ip || ""

                  const port = printer.port || NETWORK_RAW_PORT

                  const selected =
                    String(
                      selectedNetworkPrinter?.host ||
                        selectedNetworkPrinter?.ip ||
                        "",
                    ) === String(host) &&
                    Number(selectedNetworkPrinter?.port || NETWORK_RAW_PORT) ===
                      Number(port)

                  const connected =
                    printer.reachable === true || printer.connected === true

                  return (
                    <TouchableOpacity
                      key={`${host}-${port}-${index}`}
                      activeOpacity={0.85}
                      style={[
                        styles.printerItem,
                        selected && styles.printerItemSelected,
                      ]}
                      onPress={() => selectNetworkPrinter(printer)}
                    >
                      <View style={styles.networkPrinterIcon}>
                        <MaterialIcons
                          name={connected ? "wifi" : "print"}
                          size={23}
                          color={selected ? "#60A5FA" : "#64748B"}
                        />
                      </View>

                      <View style={styles.printerInfo}>
                        <Text style={styles.printerName} numberOfLines={1}>
                          {printer.name || `Network Printer ${host}`}
                        </Text>

                        <Text style={styles.printerDetails}>
                          {host} • Port {port} • RAW
                        </Text>

                        {connected && (
                          <View style={styles.networkConnectedBadge}>
                            <MaterialIcons
                              name="check-circle"
                              size={14}
                              color="#4ADE80"
                            />

                            <Text style={styles.networkConnectedText}>
                              متصلة
                            </Text>
                          </View>
                        )}
                      </View>

                      {connected ? (
                        <MaterialIcons
                          name="check-circle"
                          size={20}
                          color="#4ADE80"
                        />
                      ) : (
                        <MaterialIcons name="wifi" size={20} color="#64748B" />
                      )}
                    </TouchableOpacity>
                  )
                })}
              </View>
            )}

            {/* ------------------------------------------------------------- */}
            {/* MANUAL IP */}
            {/* ------------------------------------------------------------- */}

            <View style={styles.manualNetworkBox}>
              <View style={styles.manualNetworkTitleRow}>
                <MaterialIcons name="router" size={19} color="#60A5FA" />

                <Text style={styles.manualNetworkTitle}>
                  إضافة طابعة يدويًا
                </Text>
              </View>

              <View style={styles.networkInputRow}>
                <View style={styles.networkInputContainer}>
                  <Text style={styles.networkInputLabel}>عنوان IP</Text>

                  <TextInput
                    value={networkHost}
                    onChangeText={text => setNetworkHost(text)}
                    placeholder="192.168.1.100"
                    placeholderTextColor="#475569"
                    keyboardType="numeric"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.networkInput}
                    textAlign="left"
                  />
                </View>

                <View style={styles.networkPortContainer}>
                  <Text style={styles.networkInputLabel}>المنفذ</Text>

                  <TextInput
                    value={networkPort}
                    onChangeText={text => setNetworkPort(text)}
                    placeholder="9100"
                    placeholderTextColor="#475569"
                    keyboardType="number-pad"
                    style={styles.networkInput}
                    textAlign="center"
                  />
                </View>
              </View>

              <TouchableOpacity
                activeOpacity={0.85}
                style={styles.secondaryButton}
                onPress={useManualNetworkPrinter}
              >
                <MaterialIcons name="add-link" size={21} color="#60A5FA" />

                <Text style={styles.secondaryButtonText}>
                  استخدام هذه الطابعة
                </Text>
              </TouchableOpacity>
            </View>

            {/* ------------------------------------------------------------- */}
            {/* SELECTED NETWORK PRINTER */}
            {/* ------------------------------------------------------------- */}

            {selectedNetworkPrinter && (
              <View
                style={[
                  styles.networkSelectedBox,
                  networkConnected
                    ? styles.networkSelectedBoxConnected
                    : styles.networkSelectedBoxDisconnected,
                ]}
              >
                <View style={styles.networkSelectedIcon}>
                  <MaterialIcons
                    name={networkConnected ? "wifi" : "wifi-off"}
                    size={23}
                    color={networkConnected ? "#4ADE80" : "#FBBF24"}
                  />
                </View>

                <View style={styles.networkSelectedInfo}>
                  <Text style={styles.networkSelectedTitle}>
                    الطابعة المحددة
                  </Text>

                  <Text style={styles.networkSelectedHost}>
                    {selectedNetworkPrinter.host ||
                      selectedNetworkPrinter.ip ||
                      "-"}
                    :{selectedNetworkPrinter.port || NETWORK_RAW_PORT}
                  </Text>

                  <Text style={styles.networkSelectedMessage}>
                    {networkMessage ||
                      (networkConnected
                        ? "الطابعة جاهزة."
                        : "لم يتم اختبار الاتصال.")}
                  </Text>
                </View>
              </View>
            )}

            {/* ------------------------------------------------------------- */}
            {/* NETWORK ACTIONS */}
            {/* ------------------------------------------------------------- */}

            {selectedNetworkPrinter && (
              <>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[
                    styles.outlineButton,
                    testingNetworkPrinter && styles.disabledButton,
                  ]}
                  onPress={() => testNetworkConnection(selectedNetworkPrinter)}
                  disabled={testingNetworkPrinter}
                >
                  {testingNetworkPrinter ? (
                    <ActivityIndicator size="small" color="#60A5FA" />
                  ) : (
                    <MaterialIcons name="wifi-find" size={20} color="#60A5FA" />
                  )}

                  <Text
                    style={[
                      styles.outlineButtonText,
                      {
                        color: "#60A5FA",
                      },
                    ]}
                  >
                    {testingNetworkPrinter
                      ? "جاري فحص الاتصال..."
                      : "فحص اتصال الطابعة"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[
                    styles.outlineButton,
                    printing && styles.disabledButton,
                  ]}
                  onPress={printNetworkTest}
                  disabled={printing}
                >
                  {printing ? (
                    <ActivityIndicator size="small" color="#94A3B8" />
                  ) : (
                    <MaterialIcons
                      name="description"
                      size={20}
                      color="#94A3B8"
                    />
                  )}

                  <Text style={styles.outlineButtonText}>
                    طباعة صفحة اختبار الشبكة
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  style={styles.outlineButton}
                  onPress={inspectNetworkPrinter}
                >
                  <MaterialIcons
                    name="info-outline"
                    size={20}
                    color="#94A3B8"
                  />

                  <Text style={styles.outlineButtonText}>
                    فحص معلومات الطابعة
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* MODE SWITCHER */}
        {/* ================================================================= */}

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <MaterialIcons
                name="insert-drive-file"
                size={23}
                color="#60A5FA"
              />
            </View>

            <View style={styles.sectionHeaderText}>
              <Text style={styles.sectionTitle}>نوع المستند</Text>

              <Text style={styles.sectionSubtitle}>اختر ما تريد طباعته</Text>
            </View>
          </View>

          <View style={styles.modeSwitcher}>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.modeButton,
                printMode === "pdf" && styles.modeButtonActive,
              ]}
              onPress={() => setPrintMode("pdf")}
            >
              <MaterialIcons
                name="picture-as-pdf"
                size={23}
                color={printMode === "pdf" ? "#FFFFFF" : "#94A3B8"}
              />

              <Text
                style={[
                  styles.modeButtonText,
                  printMode === "pdf" && styles.modeButtonTextActive,
                ]}
              >
                PDF
              </Text>

              {selectedPdf && (
                <View style={styles.modeBadge}>
                  <Text style={styles.modeBadgeText}>{pdfPageCount}</Text>
                </View>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.modeButton,
                printMode === "images" && styles.modeButtonActive,
              ]}
              onPress={() => setPrintMode("images")}
            >
              <MaterialIcons
                name="photo-library"
                size={23}
                color={printMode === "images" ? "#FFFFFF" : "#94A3B8"}
              />

              <Text
                style={[
                  styles.modeButtonText,
                  printMode === "images" && styles.modeButtonTextActive,
                ]}
              >
                الصور
              </Text>

              {selectedImages.length > 0 && (
                <View style={styles.modeBadge}>
                  <Text style={styles.modeBadgeText}>
                    {selectedImages.length}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* ================================================================= */}
        {/* PDF MODE */}
        {/* ================================================================= */}

        {printMode === "pdf" && (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <View
                style={[
                  styles.sectionIcon,
                  {
                    backgroundColor: "#3B1F2B",
                  },
                ]}
              >
                <MaterialIcons
                  name="picture-as-pdf"
                  size={24}
                  color="#F87171"
                />
              </View>

              <View style={styles.sectionHeaderText}>
                <Text style={styles.sectionTitle}>ملف PDF</Text>

                <Text style={styles.sectionSubtitle}>
                  حدد الصفحات بالضغط على المعاينة
                </Text>
              </View>
            </View>

            <TouchableOpacity
              activeOpacity={0.85}
              style={styles.primaryButton}
              onPress={pickPdf}
              disabled={selectingPdf}
            >
              {selectingPdf ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <MaterialIcons name="upload-file" size={22} color="#FFFFFF" />
              )}

              <Text style={styles.primaryButtonText}>
                {selectingPdf
                  ? "جاري الاختيار..."
                  : selectedPdf
                    ? "اختيار PDF آخر"
                    : "اختيار ملف PDF"}
              </Text>
            </TouchableOpacity>

            {selectedPdf && (
              <>
                <View style={styles.fileBox}>
                  <View style={styles.fileIcon}>
                    <MaterialIcons
                      name="picture-as-pdf"
                      size={26}
                      color="#F87171"
                    />
                  </View>

                  <View style={styles.fileInfo}>
                    <Text style={styles.fileName} numberOfLines={1}>
                      {selectedPdf.name}
                    </Text>

                    <Text style={styles.fileDetails}>
                      {pdfPageCount} صفحة
                      {selectedPdf.size
                        ? ` • ${(selectedPdf.size / 1024 / 1024).toFixed(2)} MB`
                        : ""}
                    </Text>
                  </View>
                </View>

                <View style={styles.pdfPreviewContainer}>
                  <View style={styles.previewTitleRow}>
                    <MaterialIcons name="touch-app" size={19} color="#60A5FA" />

                    <Text style={styles.previewTitle}>
                      اضغط على الصفحة لتحديدها
                    </Text>
                  </View>

                  {loadingPdfPreview && pdfPreviewPages.length === 0 && (
                    <View style={styles.previewLoading}>
                      <ActivityIndicator size="large" color="#60A5FA" />

                      <Text style={styles.previewLoadingText}>
                        جاري إنشاء معاينة الصفحات...
                      </Text>
                    </View>
                  )}

                  {pdfPreviewPages.length > 0 && (
                    <>
                      <View style={styles.pdfSelectionSummary}>
                        <View style={styles.pdfSelectionSummaryText}>
                          <MaterialIcons
                            name="check-circle"
                            size={18}
                            color="#60A5FA"
                          />

                          <Text style={styles.pdfSelectionSummaryLabel}>
                            تم تحديد {pdfSelectedCount} من {pdfPageCount} صفحات
                          </Text>
                        </View>

                        <Text style={styles.pdfSelectionSummaryValue}>
                          {pdfTotalPrintPages} صفحة للطباعة
                        </Text>
                      </View>

                      <View style={styles.pdfActionsRow}>
                        <TouchableOpacity
                          activeOpacity={0.85}
                          style={styles.pdfActionButton}
                          onPress={selectAllPdfPages}
                        >
                          <MaterialIcons
                            name="select-all"
                            size={18}
                            color="#60A5FA"
                          />

                          <Text style={styles.pdfActionButtonText}>
                            تحديد الكل
                          </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          activeOpacity={0.85}
                          style={styles.pdfActionButtonDanger}
                          onPress={clearSelectedPdfPages}
                        >
                          <MaterialIcons
                            name="deselect"
                            size={18}
                            color="#F87171"
                          />

                          <Text style={styles.pdfActionButtonDangerText}>
                            إلغاء التحديد
                          </Text>
                        </TouchableOpacity>
                      </View>

                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.pdfHorizontalContent}
                        decelerationRate="fast"
                        snapToAlignment="center"
                        snapToInterval={PDF_SNAP_INTERVAL}
                      >
                        {pdfPreviewPages.map(page => {
                          const selected = isPdfPageSelected(page.pageIndex)

                          return (
                            <TouchableOpacity
                              key={`${page.pageIndex}-${page.uri}`}
                              activeOpacity={0.92}
                              onPress={() => togglePdfPage(page.pageIndex)}
                              style={[
                                styles.pdfHorizontalPage,
                                selected && styles.pdfHorizontalPageSelected,
                              ]}
                            >
                              <View style={styles.pdfPageTopRow}>
                                <View style={styles.pageNumberBadge}>
                                  <Text style={styles.pageNumberText}>
                                    صفحة {page.pageNumber} من {pdfPageCount}
                                  </Text>
                                </View>

                                <View
                                  style={[
                                    styles.pageSelectionBadge,
                                    selected &&
                                      styles.pageSelectionBadgeSelected,
                                  ]}
                                >
                                  <MaterialIcons
                                    name={
                                      selected
                                        ? "check-circle"
                                        : "radio-button-unchecked"
                                    }
                                    size={18}
                                    color={selected ? "#60A5FA" : "#64748B"}
                                  />
                                </View>
                              </View>

                              <View
                                style={[
                                  styles.pdfPreviewFrame,
                                  selected && styles.pdfPreviewFrameSelected,
                                ]}
                              >
                                <Image
                                  source={{
                                    uri: page.uri,
                                  }}
                                  style={styles.pdfHorizontalPreviewImage}
                                  resizeMode="contain"
                                />

                                {selected && (
                                  <View style={styles.selectedPageOverlay}>
                                    <MaterialIcons
                                      name="check"
                                      size={28}
                                      color="#FFFFFF"
                                    />
                                  </View>
                                )}
                              </View>

                              <Text
                                style={
                                  selected
                                    ? styles.selectedPageText
                                    : styles.unselectedPageText
                                }
                              >
                                {selected ? "محددة للطباعة" : "اضغط للتحديد"}
                              </Text>
                            </TouchableOpacity>
                          )
                        })}
                      </ScrollView>
                    </>
                  )}
                </View>

                <View style={styles.copiesBox}>
                  <View style={styles.copiesTitleRow}>
                    <MaterialIcons
                      name="content-copy"
                      size={18}
                      color="#60A5FA"
                    />

                    <Text style={styles.copiesTitle}>عدد نسخ PDF</Text>
                  </View>

                  <View style={styles.copiesControls}>
                    <TouchableOpacity
                      activeOpacity={0.8}
                      style={styles.copyButton}
                      onPress={decreasePdfCopies}
                      disabled={pdfCopies <= 1}
                    >
                      <MaterialIcons
                        name="remove"
                        size={22}
                        color={pdfCopies <= 1 ? "#475569" : "#F8FAFC"}
                      />
                    </TouchableOpacity>

                    <View style={styles.copyNumberBox}>
                      <Text style={styles.copyNumber}>{pdfCopies}</Text>
                    </View>

                    <TouchableOpacity
                      activeOpacity={0.8}
                      style={styles.copyButton}
                      onPress={increasePdfCopies}
                      disabled={pdfCopies >= 99}
                    >
                      <MaterialIcons
                        name="add"
                        size={22}
                        color={pdfCopies >= 99 ? "#475569" : "#F8FAFC"}
                      />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.summaryBox}>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>الصفحات المحددة</Text>

                    <Text style={styles.summaryValue}>{pdfSelectedCount}</Text>
                  </View>

                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>عدد النسخ</Text>

                    <Text style={styles.summaryValue}>{pdfCopies}</Text>
                  </View>

                  <View style={styles.summaryDivider} />

                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryTotalLabel}>إجمالي الصفحات</Text>

                    <Text style={styles.summaryTotalValue}>
                      {pdfTotalPrintPages}
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[
                    styles.printButton,
                    (printing || pdfSelectedCount === 0) &&
                      styles.disabledButton,
                  ]}
                  onPress={printPdf}
                  disabled={printing || pdfSelectedCount === 0}
                >
                  {printing ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <MaterialIcons name="print" size={23} color="#FFFFFF" />
                  )}

                  <Text style={styles.printButtonText}>
                    {printing
                      ? "جاري الطباعة..."
                      : `طباعة ${pdfTotalPrintPages} صفحة`}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* IMAGES MODE */}
        {/* ================================================================= */}

        {printMode === "images" && (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <MaterialIcons name="photo-library" size={24} color="#60A5FA" />
              </View>

              <View style={styles.sectionHeaderText}>
                <Text style={styles.sectionTitle}>الصور</Text>

                <Text style={styles.sectionSubtitle}>JPG / PNG / WebP</Text>
              </View>
            </View>

            <TouchableOpacity
              activeOpacity={0.85}
              style={styles.primaryButton}
              onPress={pickImages}
              disabled={selectingImages}
            >
              {selectingImages ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <MaterialIcons
                  name="add-photo-alternate"
                  size={22}
                  color="#FFFFFF"
                />
              )}

              <Text style={styles.primaryButtonText}>
                {selectingImages
                  ? "جاري الاختيار..."
                  : selectedImages.length > 0
                    ? "إضافة صور"
                    : "اختيار الصور"}
              </Text>
            </TouchableOpacity>

            {selectedImages.length > 0 && (
              <View style={styles.imagesContainer}>
                <View style={styles.imagesHeader}>
                  <Text style={styles.imagesCount}>
                    {selectedImages.length} صورة
                  </Text>

                  <TouchableOpacity activeOpacity={0.8} onPress={clearImages}>
                    <Text style={styles.clearText}>حذف الكل</Text>
                  </TouchableOpacity>
                </View>

                {loadingImagePreviews && (
                  <View style={styles.smallLoading}>
                    <ActivityIndicator size="small" color="#60A5FA" />

                    <Text style={styles.smallLoadingText}>
                      جاري تجهيز المعاينات...
                    </Text>
                  </View>
                )}

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.imageHorizontalContent}
                  decelerationRate="fast"
                  snapToAlignment="center"
                  snapToInterval={IMAGE_SNAP_INTERVAL}
                >
                  {selectedImages.map((image, index) => (
                    <View key={image.id} style={styles.imagePageCard}>
                      <View style={styles.imagePageHeader}>
                        <View style={styles.imageNumberBadge}>
                          <Text style={styles.imageNumberBadgeText}>
                            صورة {index + 1} من {selectedImages.length}
                          </Text>
                        </View>

                        <TouchableOpacity
                          activeOpacity={0.8}
                          style={styles.imageDeleteButton}
                          onPress={() => removeImage(index)}
                        >
                          <MaterialIcons
                            name="delete-outline"
                            size={19}
                            color="#F87171"
                          />

                          <Text style={styles.imageDeleteText}>حذف</Text>
                        </TouchableOpacity>
                      </View>

                      <View style={styles.imagePageFrame}>
                        <Image
                          source={{
                            uri: image.previewUri || image.uri,
                          }}
                          style={styles.imagePagePreview}
                          resizeMode="contain"
                        />
                      </View>

                      <Text style={styles.imagePageName} numberOfLines={1}>
                        {image.name}
                      </Text>
                    </View>
                  ))}
                </ScrollView>

                <View style={styles.copiesBox}>
                  <View style={styles.copiesTitleRow}>
                    <MaterialIcons
                      name="content-copy"
                      size={18}
                      color="#60A5FA"
                    />

                    <Text style={styles.copiesTitle}>عدد نسخ الصور</Text>
                  </View>

                  <View style={styles.copiesControls}>
                    <TouchableOpacity
                      activeOpacity={0.8}
                      style={styles.copyButton}
                      onPress={decreaseCopies}
                      disabled={imageCopies <= 1}
                    >
                      <MaterialIcons
                        name="remove"
                        size={22}
                        color={imageCopies <= 1 ? "#475569" : "#F8FAFC"}
                      />
                    </TouchableOpacity>

                    <View style={styles.copyNumberBox}>
                      <Text style={styles.copyNumber}>{imageCopies}</Text>
                    </View>

                    <TouchableOpacity
                      activeOpacity={0.8}
                      style={styles.copyButton}
                      onPress={increaseCopies}
                      disabled={imageCopies >= 99}
                    >
                      <MaterialIcons
                        name="add"
                        size={22}
                        color={imageCopies >= 99 ? "#475569" : "#F8FAFC"}
                      />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.summaryBox}>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>عدد الصور</Text>

                    <Text style={styles.summaryValue}>
                      {selectedImages.length}
                    </Text>
                  </View>

                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>عدد النسخ</Text>

                    <Text style={styles.summaryValue}>{imageCopies}</Text>
                  </View>

                  <View style={styles.summaryDivider} />

                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryTotalLabel}>إجمالي الصفحات</Text>

                    <Text style={styles.summaryTotalValue}>
                      {imageTotalPrintPages}
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[
                    styles.printButton,
                    printing && styles.disabledButton,
                  ]}
                  onPress={printImages}
                  disabled={printing}
                >
                  {printing ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <MaterialIcons name="print" size={23} color="#FFFFFF" />
                  )}

                  <Text style={styles.printButtonText}>
                    {printing
                      ? "جاري الطباعة..."
                      : `طباعة ${imageTotalPrintPages} صفحة`}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* USB INSPECTION */}
        {/* ================================================================= */}

        {connectionMode === "usb" && inspectedPrinter && (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <MaterialIcons
                  name="settings-input-component"
                  size={23}
                  color="#A78BFA"
                />
              </View>

              <View style={styles.sectionHeaderText}>
                <Text style={styles.sectionTitle}>معلومات اتصال الطابعة</Text>

                <Text style={styles.sectionSubtitle}>USB Printer Class</Text>
              </View>
            </View>

            <View style={styles.infoGrid}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>اسم الطابعة</Text>

                <Text style={styles.infoValue} numberOfLines={1}>
                  {inspectedPrinter.name || "-"}
                </Text>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Vendor ID</Text>

                <Text style={styles.infoValue}>
                  {inspectedPrinter.vendorId || "-"}
                </Text>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Product ID</Text>

                <Text style={styles.infoValue}>
                  {inspectedPrinter.productId || "-"}
                </Text>
              </View>

              <View
                style={[
                  styles.infoRow,
                  {
                    borderBottomWidth: 0,
                  },
                ]}
              >
                <Text style={styles.infoLabel}>Interface Count</Text>

                <Text style={styles.infoValue}>
                  {inspectedPrinter.interfaceCount}
                </Text>
              </View>
            </View>

            {Array.isArray(inspectedPrinter.interfaces) &&
              inspectedPrinter.interfaces.map((usbInterface, index) => (
                <View key={`interface-${index}`} style={styles.interfaceBox}>
                  <Text style={styles.interfaceTitle}>
                    Interface {usbInterface.id}
                  </Text>

                  <Text style={styles.interfaceText}>
                    Class: {usbInterface.interfaceClass}
                  </Text>

                  <Text style={styles.interfaceText}>
                    Subclass: {usbInterface.subclass}
                  </Text>

                  <Text style={styles.interfaceText}>
                    Protocol: {usbInterface.protocol}
                  </Text>

                  {Array.isArray(usbInterface.endpoints) &&
                    usbInterface.endpoints.map((endpoint, endpointIndex) => (
                      <View
                        key={`endpoint-${endpointIndex}`}
                        style={styles.endpointBox}
                      >
                        <Text style={styles.endpointText}>
                          Endpoint: {endpoint.address}
                        </Text>

                        <Text style={styles.endpointText}>
                          Direction: {endpoint.direction}
                        </Text>

                        <Text style={styles.endpointText}>
                          Type: {endpoint.type}
                        </Text>

                        <Text style={styles.endpointText}>
                          Max Packet: {endpoint.maxPacketSize}
                        </Text>
                      </View>
                    ))}
                </View>
              ))}
          </View>
        )}

        {/* ================================================================= */}
        {/* NETWORK INSPECTION */}
        {/* ================================================================= */}

        {connectionMode === "network" && inspectedNetworkPrinter && (
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <MaterialIcons name="wifi" size={23} color="#A78BFA" />
              </View>

              <View style={styles.sectionHeaderText}>
                <Text style={styles.sectionTitle}>معلومات اتصال الطابعة</Text>

                <Text style={styles.sectionSubtitle}>RAW TCP / PCL</Text>
              </View>
            </View>

            <View style={styles.infoGrid}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>عنوان IP</Text>

                <Text style={styles.infoValue}>
                  {inspectedNetworkPrinter.host ||
                    inspectedNetworkPrinter.ip ||
                    "-"}
                </Text>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>المنفذ</Text>

                <Text style={styles.infoValue}>
                  {inspectedNetworkPrinter.port || NETWORK_RAW_PORT}
                </Text>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>البروتوكول</Text>

                <Text style={styles.infoValue}>RAW / PCL</Text>
              </View>

              <View
                style={[
                  styles.infoRow,
                  {
                    borderBottomWidth: 0,
                  },
                ]}
              >
                <Text style={styles.infoLabel}>حالة الاتصال</Text>

                <Text
                  style={[
                    styles.infoValue,
                    {
                      color:
                        inspectedNetworkPrinter.reachable ||
                        inspectedNetworkPrinter.connected ||
                        inspectedNetworkPrinter.success
                          ? "#4ADE80"
                          : "#FBBF24",
                    },
                  ]}
                >
                  {inspectedNetworkPrinter.reachable ||
                  inspectedNetworkPrinter.connected ||
                  inspectedNetworkPrinter.success
                    ? "متصل"
                    : "غير متصل"}
                </Text>
              </View>
            </View>

            {inspectedNetworkPrinter.latencyMs != null && (
              <View style={styles.networkLatencyBox}>
                <MaterialIcons name="speed" size={18} color="#60A5FA" />

                <Text style={styles.networkLatencyText}>
                  زمن الاستجابة: {inspectedNetworkPrinter.latencyMs} ms
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ================================================================= */}
        {/* FOOTER */}
        {/* ================================================================= */}

        <View style={styles.footer}>
          <MaterialIcons name="print" size={16} color="#475569" />

          <Text style={styles.footerText}>Avocato Print</Text>
        </View>
      </ScrollView>
    </View>
  )
}

// =============================================================================
// STYLES
// =============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F172A",
  },

  scroll: {
    flex: 1,
  },

  content: {
    padding: 16,
    paddingBottom: 40,
  },

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  header: {
    backgroundColor: "#111827",
    paddingHorizontal: 18,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
    marginHorizontal: -16,
    marginTop: -16,
    marginBottom: 16,
  },

  headerIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "#172554",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },

  headerTextContainer: {
    flex: 1,
  },

  headerTitle: {
    color: "#F8FAFC",
    fontSize: 21,
    fontWeight: "800",
  },

  headerSubtitle: {
    color: "#94A3B8",
    fontSize: 13,
    marginTop: 3,
  },

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  card: {
    backgroundColor: "#111827",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 16,
    marginBottom: 14,
  },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },

  sectionIcon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: "#172554",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 11,
  },

  sectionHeaderText: {
    flex: 1,
  },

  sectionTitle: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "800",
  },

  sectionSubtitle: {
    color: "#64748B",
    fontSize: 12,
    marginTop: 3,
  },

  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#172554",
    alignItems: "center",
    justifyContent: "center",
  },

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  connectionSwitcher: {
    flexDirection: "row",
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 5,
    gap: 6,
  },

  connectionButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 11,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },

  connectionButtonActive: {
    backgroundColor: "#2563EB",
  },

  connectionButtonText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "800",
  },

  connectionButtonTextActive: {
    color: "#FFFFFF",
  },

  // -------------------------------------------------------------------------
  // Printer
  // -------------------------------------------------------------------------

  printerItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 12,
    marginBottom: 9,
  },

  printerItemSelected: {
    borderColor: "#2563EB",
    backgroundColor: "#172554",
  },

  printerIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 11,
  },

  networkPrinterIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 11,
  },

  printerInfo: {
    flex: 1,
  },

  printerName: {
    color: "#F8FAFC",
    fontSize: 14,
    fontWeight: "700",
  },

  printerDetails: {
    color: "#64748B",
    fontSize: 11,
    marginTop: 4,
  },

  permissionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#052E16",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 9,
  },

  permissionText: {
    color: "#4ADE80",
    fontSize: 10,
    fontWeight: "700",
  },

  permissionStatus: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    marginTop: 7,
    gap: 5,
  },

  permissionStatusGranted: {
    backgroundColor: "#052E16",
    borderWidth: 1,
    borderColor: "#166534",
  },

  permissionStatusDenied: {
    backgroundColor: "#422006",
    borderWidth: 1,
    borderColor: "#92400E",
  },

  permissionStatusText: {
    fontSize: 10,
    fontWeight: "800",
  },

  permissionStatusTextGranted: {
    color: "#4ADE80",
  },

  permissionStatusTextDenied: {
    color: "#FBBF24",
  },

  // -------------------------------------------------------------------------
  // USB Permission
  // -------------------------------------------------------------------------

  permissionLargeBox: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    marginTop: 10,
  },

  permissionLargeBoxGranted: {
    backgroundColor: "#052E16",
    borderColor: "#166534",
  },

  permissionLargeBoxDenied: {
    backgroundColor: "#422006",
    borderColor: "#92400E",
  },

  permissionLargeIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },

  permissionLargeInfo: {
    flex: 1,
  },

  permissionLargeTitle: {
    color: "#CBD5E1",
    fontSize: 11,
    fontWeight: "700",
  },

  permissionLargeText: {
    fontSize: 13,
    fontWeight: "900",
    marginTop: 4,
  },

  permissionLargeTextGranted: {
    color: "#4ADE80",
  },

  permissionLargeTextDenied: {
    color: "#FBBF24",
  },

  permissionHintGranted: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: "#052E16",
    borderWidth: 1,
    borderColor: "#166534",
  },

  permissionHintGrantedText: {
    color: "#86EFAC",
    fontSize: 11,
    fontWeight: "700",
  },

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------

  networkInfoBox: {
    backgroundColor: "#0F172A",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#1E293B",
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginBottom: 10,
  },

  networkInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
  },

  networkInfoLabel: {
    color: "#64748B",
    fontSize: 11,
  },

  networkInfoValue: {
    color: "#60A5FA",
    fontSize: 12,
    fontWeight: "800",
  },

  networkPrintersContainer: {
    marginTop: 14,
  },

  networkListTitle: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 10,
  },

  networkConnectedBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    marginTop: 7,
    backgroundColor: "#052E16",
    borderWidth: 1,
    borderColor: "#166534",
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },

  networkConnectedText: {
    color: "#4ADE80",
    fontSize: 10,
    fontWeight: "800",
  },

  manualNetworkBox: {
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 13,
    marginTop: 12,
  },

  manualNetworkTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginBottom: 11,
  },

  manualNetworkTitle: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "800",
  },

  networkInputRow: {
    flexDirection: "row",
    gap: 9,
  },

  networkInputContainer: {
    flex: 1,
  },

  networkPortContainer: {
    width: 95,
  },

  networkInputLabel: {
    color: "#64748B",
    fontSize: 10,
    fontWeight: "700",
    marginBottom: 6,
  },

  networkInput: {
    minHeight: 46,
    borderRadius: 11,
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#334155",
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 11,
  },

  networkSelectedBox: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    marginTop: 12,
  },

  networkSelectedBoxConnected: {
    backgroundColor: "#052E16",
    borderColor: "#166534",
  },

  networkSelectedBoxDisconnected: {
    backgroundColor: "#422006",
    borderColor: "#92400E",
  },

  networkSelectedIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },

  networkSelectedInfo: {
    flex: 1,
  },

  networkSelectedTitle: {
    color: "#CBD5E1",
    fontSize: 11,
    fontWeight: "700",
  },

  networkSelectedHost: {
    color: "#F8FAFC",
    fontSize: 15,
    fontWeight: "900",
    marginTop: 3,
  },

  networkSelectedMessage: {
    color: "#94A3B8",
    fontSize: 10,
    marginTop: 4,
  },

  networkLatencyBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#172554",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1D4ED8",
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 10,
  },

  networkLatencyText: {
    color: "#BFDBFE",
    fontSize: 11,
    fontWeight: "700",
  },

  // -------------------------------------------------------------------------
  // Empty
  // -------------------------------------------------------------------------

  emptyBox: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
  },

  emptyText: {
    color: "#64748B",
    fontSize: 13,
    marginTop: 10,
  },

  // -------------------------------------------------------------------------
  // Buttons
  // -------------------------------------------------------------------------

  primaryButton: {
    minHeight: 48,
    borderRadius: 13,
    backgroundColor: "#2563EB",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 15,
    gap: 8,
    marginTop: 8,
  },

  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
  },

  secondaryButton: {
    minHeight: 48,
    borderRadius: 13,
    backgroundColor: "#172554",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 15,
    gap: 8,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#1D4ED8",
  },

  secondaryButtonText: {
    color: "#60A5FA",
    fontSize: 14,
    fontWeight: "800",
  },

  outlineButton: {
    minHeight: 46,
    borderRadius: 13,
    backgroundColor: "#0F172A",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 15,
    gap: 8,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#334155",
  },

  outlineButtonText: {
    color: "#94A3B8",
    fontSize: 14,
    fontWeight: "700",
  },

  printButton: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: "#2563EB",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    gap: 9,
    marginTop: 14,
  },

  disabledButton: {
    backgroundColor: "#334155",
    opacity: 0.65,
  },

  printButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "900",
  },

  // -------------------------------------------------------------------------
  // Mode
  // -------------------------------------------------------------------------

  modeSwitcher: {
    flexDirection: "row",
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 5,
    gap: 6,
  },

  modeButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 11,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 10,
  },

  modeButtonActive: {
    backgroundColor: "#2563EB",
  },

  modeButtonText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "800",
  },

  modeButtonTextActive: {
    color: "#FFFFFF",
  },

  modeBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#1E3A8A",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
  },

  modeBadgeText: {
    color: "#BFDBFE",
    fontSize: 10,
    fontWeight: "900",
  },

  // -------------------------------------------------------------------------
  // File
  // -------------------------------------------------------------------------

  fileBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 12,
    marginTop: 13,
  },

  fileIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: "#3B1F2B",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 11,
  },

  fileInfo: {
    flex: 1,
  },

  fileName: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "700",
  },

  fileDetails: {
    color: "#64748B",
    fontSize: 11,
    marginTop: 4,
  },

  // -------------------------------------------------------------------------
  // PDF Preview
  // -------------------------------------------------------------------------

  previewLoading: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
  },

  previewLoadingText: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 10,
  },

  pdfPreviewContainer: {
    marginTop: 16,
  },

  previewTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginBottom: 10,
  },

  previewTitle: {
    color: "#F8FAFC",
    fontSize: 14,
    fontWeight: "800",
  },

  pdfSelectionSummary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#0F172A",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1E293B",
    paddingHorizontal: 11,
    paddingVertical: 10,
    marginBottom: 10,
  },

  pdfSelectionSummaryText: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },

  pdfSelectionSummaryLabel: {
    color: "#F8FAFC",
    fontSize: 11,
    fontWeight: "800",
  },

  pdfSelectionSummaryValue: {
    color: "#60A5FA",
    fontSize: 11,
    fontWeight: "900",
  },

  pdfActionsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 11,
  },

  pdfActionButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 11,
    backgroundColor: "#172554",
    borderWidth: 1,
    borderColor: "#1D4ED8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },

  pdfActionButtonText: {
    color: "#60A5FA",
    fontSize: 11,
    fontWeight: "800",
  },

  pdfActionButtonDanger: {
    flex: 1,
    minHeight: 42,
    borderRadius: 11,
    backgroundColor: "#1F1720",
    borderWidth: 1,
    borderColor: "#4C2631",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },

  pdfActionButtonDangerText: {
    color: "#F87171",
    fontSize: 11,
    fontWeight: "800",
  },

  pdfHorizontalContent: {
    paddingHorizontal: 2,
    paddingBottom: 8,
  },

  pdfHorizontalPage: {
    width: 280,
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 10,
    marginRight: 14,
  },

  pdfHorizontalPageSelected: {
    borderColor: "#2563EB",
    backgroundColor: "#172554",
  },

  pdfPageTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 9,
  },

  pageNumberBadge: {
    alignSelf: "center",
    backgroundColor: "#172554",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },

  pageNumberText: {
    color: "#60A5FA",
    fontSize: 11,
    fontWeight: "700",
  },

  pageSelectionBadge: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },

  pageSelectionBadgeSelected: {
    backgroundColor: "#172554",
  },

  pdfPreviewFrame: {
    width: "100%",
    height: 390,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },

  pdfPreviewFrameSelected: {
    borderWidth: 3,
    borderColor: "#2563EB",
  },

  pdfHorizontalPreviewImage: {
    width: "100%",
    height: "100%",
    backgroundColor: "#FFFFFF",
  },

  selectedPageOverlay: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#2563EB",
    alignItems: "center",
    justifyContent: "center",
  },

  selectedPageText: {
    color: "#60A5FA",
    fontSize: 11,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 8,
  },

  unselectedPageText: {
    color: "#64748B",
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 8,
  },

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  imagesContainer: {
    marginTop: 14,
  },

  imagesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },

  imagesCount: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "800",
  },

  clearText: {
    color: "#F87171",
    fontSize: 12,
    fontWeight: "700",
  },

  smallLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },

  smallLoadingText: {
    color: "#64748B",
    fontSize: 11,
  },

  imageHorizontalContent: {
    paddingHorizontal: 2,
    paddingBottom: 8,
  },

  imagePageCard: {
    width: 280,
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 10,
    marginRight: 14,
  },

  imagePageHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 9,
  },

  imageNumberBadge: {
    backgroundColor: "#172554",
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },

  imageNumberBadgeText: {
    color: "#60A5FA",
    fontSize: 11,
    fontWeight: "700",
  },

  imageDeleteButton: {
    minHeight: 32,
    borderRadius: 9,
    backgroundColor: "#3B1F2B",
    borderWidth: 1,
    borderColor: "#4C2631",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 8,
  },

  imageDeleteText: {
    color: "#F87171",
    fontSize: 10,
    fontWeight: "800",
  },

  imagePageFrame: {
    width: "100%",
    height: 390,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E2E8F0",
  },

  imagePagePreview: {
    width: "100%",
    height: "100%",
    backgroundColor: "#FFFFFF",
  },

  imagePageName: {
    color: "#CBD5E1",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 9,
    textAlign: "center",
  },

  // -------------------------------------------------------------------------
  // Copies
  // -------------------------------------------------------------------------

  copiesBox: {
    backgroundColor: "#0F172A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 13,
    marginTop: 8,
  },

  copiesTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },

  copiesTitle: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "800",
  },

  copiesControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 13,
    gap: 14,
  },

  copyButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#1E293B",
    alignItems: "center",
    justifyContent: "center",
  },

  copyNumberBox: {
    minWidth: 70,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#172554",
    borderWidth: 1,
    borderColor: "#2563EB",
    alignItems: "center",
    justifyContent: "center",
  },

  copyNumber: {
    color: "#60A5FA",
    fontSize: 20,
    fontWeight: "900",
  },

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  summaryBox: {
    backgroundColor: "#172554",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#1D4ED8",
    padding: 13,
    marginTop: 12,
  },

  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 5,
  },

  summaryLabel: {
    color: "#94A3B8",
    fontSize: 12,
  },

  summaryValue: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "800",
  },

  summaryDivider: {
    height: 1,
    backgroundColor: "#1E3A8A",
    marginVertical: 5,
  },

  summaryTotalLabel: {
    color: "#BFDBFE",
    fontSize: 13,
    fontWeight: "800",
  },

  summaryTotalValue: {
    color: "#60A5FA",
    fontSize: 18,
    fontWeight: "900",
  },

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  infoGrid: {
    backgroundColor: "#0F172A",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#1E293B",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },

  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
  },

  infoLabel: {
    color: "#64748B",
    fontSize: 11,
  },

  infoValue: {
    color: "#F8FAFC",
    fontSize: 12,
    fontWeight: "700",
    maxWidth: "60%",
    textAlign: "right",
  },

  interfaceBox: {
    backgroundColor: "#0F172A",
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 12,
    marginTop: 10,
  },

  interfaceTitle: {
    color: "#A78BFA",
    fontSize: 13,
    fontWeight: "900",
    marginBottom: 6,
  },

  interfaceText: {
    color: "#94A3B8",
    fontSize: 11,
    marginTop: 3,
  },

  endpointBox: {
    backgroundColor: "#111827",
    borderRadius: 9,
    padding: 9,
    marginTop: 8,
  },

  endpointText: {
    color: "#CBD5E1",
    fontSize: 11,
    marginTop: 2,
  },

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------

  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 16,
  },

  footerText: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "700",
  },
})

export default PrintScreen
