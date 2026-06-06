import { useEffect, useRef, useState, useCallback } from "react";
import * as XLSX from "xlsx";
import "./App.css";

const TARGET_LICENSE_PLATES = ["A33233/40337", "A21457/37737"];
const TARGET_LICENSE_PLATE_SET = new Set(TARGET_LICENSE_PLATES.map(normalizePlate));
const SUPABASE_URL = "https://ceaznmvgerreomiklcwo.supabase.co";
const SUPABASE_KEY = "sb_publishable_kF30JdMpqmsM9VmXPZLYAw_i8V58YJJ";
const SUPABASE_TABLE = "truck_arrivals";
const SUBDIVIDERS_TABLE = "subdividers";

function supabaseHeaders(extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...extra };
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  if (text.includes("<!DOCTYPE")) throw new Error("Server returned HTML instead of JSON.");
  throw new Error(text || "Unexpected response from server.");
}

function normalizeValue(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function toDbValue(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizePlate(value) {
  return String(value || "").trim().toUpperCase();
}

function formatPlateLabel(value) {
  const plate = normalizePlate(value);
  return plate.split("/")[0] || plate;
}

function formatExtractionDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA").format(date);
}

function formatExtractionTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function parseRows(matrix, extractionDate, extractionTime) {
  const rows = matrix
    .map((row) => (Array.isArray(row) ? row : []))
    .filter((row) => {
      const serial = String(row[0] || "").trim();
      const plate = String(row[1] || "").trim();
      const code = String(row[2] || "").trim();
      return /^\d+$/.test(serial) && plate && code;
    })
    .map((row) => ({
      arrival_date: extractionDate, batch_time: extractionTime,
      license_plate: String(row[1] || "").trim(), arrival_code: String(row[2] || "").trim(),
      product_type: String(row[3] || "").trim(), company: String(row[4] || "").trim()
    }));

  const targetRows = TARGET_LICENSE_PLATES.flatMap((plate) => {
    const targetPlate = normalizePlate(plate);
    return rows
      .filter((row) => normalizePlate(row.license_plate) === targetPlate)
      .map((row) => ({ ...row, target_plate: targetPlate }));
  });

  return { rows, targetRows };
}

function readWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try { resolve(XLSX.read(e.target.result, { type: "binary" })); }
      catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsBinaryString(file);
  });
}

async function parseBatchFile(file) {
  const workbook = await readWorkbook(file);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The workbook has no sheets.");
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!matrix.length) throw new Error("No data rows found in the file.");
  const now = new Date();
  const parsed = parseRows(matrix, formatExtractionDate(now), formatExtractionTime(now));
  if (!parsed.rows.length) throw new Error("No arrival rows found in the file.");
  return parsed;
}

function isRecentRow(row) {
  if (!row.created_at) return false;
  return (new Date() - new Date(row.created_at)) < 60 * 1000;
}

// Merge arrivals and subdividers into a single ordered list
function mergeRowsWithDividers(arrivals, dividers) {
  const dividerByAnchor = new Map();

  dividers.forEach((divider) => {
    const anchorKey = [
      normalizePlate(divider.license_plate),
      normalizeValue(divider.positioned_above_code),
      normalizeValue(divider.positioned_above_date),
      normalizeValue(divider.positioned_above_time)
    ].join("|");

    dividerByAnchor.set(anchorKey, divider);
  });

  const merged = [];
  arrivals.forEach((row) => {
    const rowKey = [
      normalizePlate(row.license_plate),
      normalizeValue(row.arrival_code),
      normalizeValue(row.arrival_date),
      normalizeValue(row.batch_time)
    ].join("|");

    const divider = dividerByAnchor.get(rowKey);
    if (divider) {
      merged.push({ __type: "divider", ...divider });
    }
    merged.push({ __type: "row", ...row });
  });
  return merged;
}

function App() {
  const [file, setFile] = useState(null);
  const [savedRows, setSavedRows] = useState([]);
  const [subdividers, setSubdividers] = useState([]);
  const [selectedPlate, setSelectedPlate] = useState(TARGET_LICENSE_PLATES[0]);
  const [targetRows, setTargetRows] = useState([]);
  const [saveComplete, setSaveComplete] = useState(false);
  const [showTopButton, setShowTopButton] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Shortcut popup
  const [shortcutPopup, setShortcutPopup] = useState(null);
  const [highlightedIds, setHighlightedIds] = useState(new Set());
  const highlightTimerRef = useRef(null);

  // Plus menu: null | 'choose' | 'file' | 'manual'
  const [plusMode, setPlusMode] = useState(null);

  // Manual entry fields
  const [manualFields, setManualFields] = useState({ license_plate: "", arrival_code: "", arrival_date: "", batch_time: "", product_type: "", company: "", paid: false });
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState("");

  // Context menu
  const [contextMenu, setContextMenu] = useState(null);
  const longPressTimer = useRef(null);
  const contextMenuRef = useRef(null);

  // Confirm modal: { type: 'paid'|'delete', row }
  const [confirmModal, setConfirmModal] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // Subdivide label input
  const [subdivideTarget, setSubdivideTarget] = useState(null); // the row to subdivide above
  const [subdivideLabel, setSubdivideLabel] = useState("");
  const [subdivideSaving, setSubdivideSaving] = useState(false);

  // Edit modal
  const [editRow, setEditRow] = useState(null);
  const [editFields, setEditFields] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  // Pull-to-refresh
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullStartY = useRef(null);
  const pullCurrentY = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const PULL_THRESHOLD = 72;

  const fileInputRef = useRef(null);

  const clearError = () => setError("");
  const clearNotice = () => setNotice("");

  const resetScanState = () => {
    setFile(null); setTargetRows([]); setSaveComplete(false);
    setLoading(false); setSaving(false); clearNotice(); clearError();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const loadSubdividers = useCallback(async () => {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/${SUBDIVIDERS_TABLE}?select=*&order=created_at.asc`,
        { headers: supabaseHeaders() }
      );
      const data = await readJsonResponse(resp);
      setSubdividers(Array.isArray(data) ? data : []);
    } catch { /* non-critical */ }
  }, []);

  const loadSavedRows = useCallback(async () => {
    let response;
    try {
      response = await fetch(
        `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?select=id,paid,arrival_date,batch_time,license_plate,arrival_code,product_type,company,created_at&order=created_at.desc&limit=50`,
        { headers: supabaseHeaders() }
      );
    } catch { throw new Error("Could not reach Supabase."); }
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error?.message || data.message || "Failed to load rows");
    setSavedRows(data || []);
    return data || [];
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadSavedRows(), loadSubdividers()]);
  }, [loadSavedRows, loadSubdividers]);

  const startHighlightTimer = useCallback((ids) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedIds(ids);
    highlightTimerRef.current = setTimeout(() => setHighlightedIds(new Set()), 5 * 60 * 1000);
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    const handler = (e) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target)) setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("touchstart", handler); };
  }, []);

  // On mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") === "shortcut") {
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(async () => {
        try {
          const rows = await loadSavedRows();
          await loadSubdividers();
          const recentRows = rows.filter((row) => TARGET_LICENSE_PLATE_SET.has(normalizePlate(row.license_plate)) && isRecentRow(row));
          if (recentRows.length > 0) {
            setSelectedPlate(recentRows[0].license_plate);
            startHighlightTimer(new Set(recentRows.map((r) => r.id)));
            setShortcutPopup({ status: "saved", rows: recentRows });
          } else {
            setShortcutPopup({ status: "not_found", rows: [] });
          }
        } catch { setShortcutPopup({ status: "not_found", rows: [] }); }
      }, 2000);
    } else {
      loadAll().catch((err) => setError(err.message));
    }
    return () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); };
  }, [loadAll, loadSavedRows, loadSubdividers, startHighlightTimer]);

  // Viewport + scroll
  useEffect(() => {
    const updateViewport = () => setIsMobile(window.innerWidth <= 720);
    const updateScroll = () => setShowTopButton(window.scrollY > 280);
    updateViewport(); updateScroll();
    window.addEventListener("resize", updateViewport);
    window.addEventListener("scroll", updateScroll, { passive: true });
    return () => { window.removeEventListener("resize", updateViewport); window.removeEventListener("scroll", updateScroll); };
  }, []);

  // Pull-to-refresh
  useEffect(() => {
    if (!isMobile) return;
    const onTouchStart = (e) => { pullStartY.current = window.scrollY === 0 ? e.touches[0].clientY : null; };
    const onTouchMove = (e) => {
      if (pullStartY.current === null) return;
      const delta = e.touches[0].clientY - pullStartY.current;
      if (delta > 0) { pullCurrentY.current = delta; setPullDistance(Math.min(delta, PULL_THRESHOLD + 20)); }
    };
    const onTouchEnd = async () => {
      if (pullCurrentY.current >= PULL_THRESHOLD) {
        setPullRefreshing(true);
        try { await loadAll(); } catch (err) { setError(err.message); }
        finally { setPullRefreshing(false); }
      }
      pullStartY.current = null; pullCurrentY.current = 0; setPullDistance(0);
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, loadAll]);

  // ── File import ───────────────────────────────────────────
  const openFilePicker = () => { fileInputRef.current?.click(); setPlusMode(null); };

  const handleFileSelected = async (nextFile) => {
    if (!nextFile) return;
    setFile(nextFile); setLoading(true); setSaving(false);
    clearNotice(); clearError();
    setSelectedPlate(TARGET_LICENSE_PLATES[0]); setTargetRows([]); setSaveComplete(false);
    try {
      const parsed = await parseBatchFile(nextFile);
      setTargetRows(parsed.targetRows);
      setSelectedPlate(parsed.targetRows[0]?.license_plate || TARGET_LICENSE_PLATES[0]);
      if (!parsed.targetRows.length) setError("No target plates found in the file.");
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleSave = async () => {
    if (!targetRows.length) return;
    setSaving(true); clearNotice(); clearError();
    try {
      const payload = targetRows.map((row) => ({
        arrival_date: toDbValue(row.arrival_date), batch_time: toDbValue(row.batch_time),
        license_plate: String(row.license_plate || "").trim(), arrival_code: String(row.arrival_code || "").trim(),
        product_type: toDbValue(row.product_type), company: toDbValue(row.company)
      }));
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
        method: "POST",
        headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
        body: JSON.stringify(payload)
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error?.message || data.message || "Save failed");
      setSelectedPlate(normalizePlate(payload[0]?.license_plate || selectedPlate));
      setTargetRows([]); setSaveComplete(true);
      setNotice(`Saved ${payload.length} row${payload.length === 1 ? "" : "s"}.`);
      await loadAll();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  // ── Manual entry ──────────────────────────────────────────
  const handleManualSave = async () => {
    if (!manualFields.license_plate.trim() || !manualFields.arrival_code.trim()) {
      setManualError("License plate and arrival code are required."); return;
    }
    setManualSaving(true); setManualError("");
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
        method: "POST",
        headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
        body: JSON.stringify([{
          license_plate: manualFields.license_plate.trim(),
          arrival_code: manualFields.arrival_code.trim(),
          arrival_date: toDbValue(manualFields.arrival_date),
          batch_time: toDbValue(manualFields.batch_time),
          product_type: toDbValue(manualFields.product_type),
          company: toDbValue(manualFields.company),
          paid: manualFields.paid
        }])
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error?.message || data.message || "Save failed");
      setPlusMode(null);
      setManualFields({ license_plate: "", arrival_code: "", arrival_date: "", batch_time: "", product_type: "", company: "", paid: false });
      await loadAll();
    } catch (err) { setManualError(err.message); }
    finally { setManualSaving(false); }
  };

  // ── Confirm modal actions ─────────────────────────────────
  const handleConfirm = async () => {
    if (!confirmModal) return;
    setConfirmLoading(true);
    try {
      if (confirmModal.type === "paid") {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${confirmModal.row.id}`, {
          method: "PATCH",
          headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
          body: JSON.stringify({ paid: !confirmModal.row.paid })
        });
        if (!response.ok) throw new Error("Failed to update payment status");
      } else if (confirmModal.type === "delete") {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${confirmModal.row.id}`, {
          method: "DELETE", headers: supabaseHeaders()
        });
        if (!response.ok) throw new Error("Failed to delete row");
      } else if (confirmModal.type === "deleteDivider") {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUBDIVIDERS_TABLE}?id=eq.${confirmModal.row.id}`, {
          method: "DELETE", headers: supabaseHeaders()
        });
        if (!response.ok) throw new Error("Failed to delete divider");
      }
      await loadAll();
      setConfirmModal(null);
    } catch (err) { setError(err.message); setConfirmModal(null); }
    finally { setConfirmLoading(false); }
  };

  // ── Edit modal ────────────────────────────────────────────
  const openEditModal = (row) => {
    setContextMenu(null);
    setEditRow(row);
    setEditFields({
      arrival_date: row.arrival_date || "", batch_time: row.batch_time || "",
      license_plate: row.license_plate || "", arrival_code: row.arrival_code || "",
      product_type: row.product_type || "", company: row.company || ""
    });
    setEditError("");
  };

  const closeEditModal = () => { setEditRow(null); setEditFields({}); setEditError(""); };

  const handleEditSave = async () => {
    if (!editRow) return;
    setEditSaving(true); setEditError("");
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${editRow.id}`, {
        method: "PATCH",
        headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
        body: JSON.stringify({
          arrival_date: toDbValue(editFields.arrival_date), batch_time: toDbValue(editFields.batch_time),
          license_plate: editFields.license_plate.trim(), arrival_code: editFields.arrival_code.trim(),
          product_type: toDbValue(editFields.product_type), company: toDbValue(editFields.company)
        })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error?.message || data.message || "Update failed");
      await loadAll(); closeEditModal();
    } catch (err) { setEditError(err.message); }
    finally { setEditSaving(false); }
  };

  // ── Subdivide ─────────────────────────────────────────────
  const handleSubdivideSubmit = async () => {
    if (!subdivideTarget || !subdivideLabel.trim()) return;
    setSubdivideSaving(true);
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUBDIVIDERS_TABLE}`, {
        method: "POST",
        headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
        body: JSON.stringify([{
          label: subdivideLabel.trim(),
          license_plate: subdivideTarget.license_plate,
          positioned_above_code: subdivideTarget.arrival_code,
          positioned_above_date: subdivideTarget.arrival_date,
          positioned_above_time: subdivideTarget.batch_time
        }])
      });
      if (!response.ok) throw new Error("Failed to save divider");
      await loadSubdividers();
      setSubdivideTarget(null); setSubdivideLabel("");
    } catch (err) { setError(err.message); }
    finally { setSubdivideSaving(false); }
  };

  // ── Context menu ──────────────────────────────────────────
  const openContextMenu = (e, row) => {
    e.preventDefault();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    setContextMenu({ row, x, y });
  };

  const handleRowTouchStart = (e, row) => {
    longPressTimer.current = setTimeout(() => openContextMenu(e, row), 600);
  };
  const handleRowTouchEnd = () => { if (longPressTimer.current) clearTimeout(longPressTimer.current); };

  // ── Table data ────────────────────────────────────────────
  const visibleRows = savedRows.filter((row) => TARGET_LICENSE_PLATE_SET.has(normalizePlate(row.license_plate)));
  const plateRows = visibleRows.filter((row) => normalizePlate(row.license_plate) === normalizePlate(selectedPlate));
  const plateSubdividers = subdividers.filter((d) => normalizePlate(d.license_plate) === normalizePlate(selectedPlate));
  const mergedRows = mergeRowsWithDividers(plateRows, plateSubdividers);

  const scanState = !file ? null : loading ? "loading" : targetRows.length && !saveComplete ? "found" : saveComplete ? "saved" : file ? "not_found" : null;
  const mobileStatus = loading ? "loading" : saveComplete ? "saved" : targetRows.length ? "found" : file ? "not_found" : "idle";

  let rowIndex = 0;

  return (
    <div className="page">

      {/* ── Pull-to-refresh ── */}
      {isMobile && (pullDistance > 0 || pullRefreshing) ? (
        <div className="pull-indicator" style={{ height: pullRefreshing ? 48 : Math.min(pullDistance, PULL_THRESHOLD + 20) }}>
          {pullRefreshing ? <div className="spinner small" /> : (
            <span className="pull-arrow" style={{ opacity: pullDistance / PULL_THRESHOLD }}>
              {pullDistance >= PULL_THRESHOLD ? "↑ Release to refresh" : "↓ Pull to refresh"}
            </span>
          )}
        </div>
      ) : null}

      <div className="shell">

        {/* ── Header ── */}
        <header className="topbar">
          <img className="brand-logo" src="/logo.png" alt="Truck Tracker logo" />
        </header>

        {/* ── Shortcut popup ── */}
        {shortcutPopup ? (
          <div className="shortcut-backdrop" role="presentation">
            <div className={`shortcut-popup ${shortcutPopup.status}`}>
              <button type="button" className="shortcut-close" onClick={() => setShortcutPopup(null)}>✕</button>
              {shortcutPopup.status === "saved" ? (
                <>
                  <div className="shortcut-icon found-icon">✓</div>
                  <strong>Saved from WhatsApp</strong>
                  <p>{shortcutPopup.rows.length} row{shortcutPopup.rows.length === 1 ? "" : "s"} saved.</p>
                  <div className="shortcut-rows">
                    {shortcutPopup.rows.map((row, i) => (
                      <div key={row.id || i} className="shortcut-row-item">
                        <span className="shortcut-plate">{formatPlateLabel(row.license_plate)}</span>
                        <span className="shortcut-detail">{normalizeValue(row.arrival_code)} · {normalizeValue(row.arrival_date)} · {normalizeValue(row.batch_time)}</span>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="shortcut-dismiss-btn green" onClick={() => setShortcutPopup(null)}>View in table</button>
                </>
              ) : (
                <>
                  <div className="shortcut-icon not-found-icon">✕</div>
                  <strong>Nothing was saved</strong>
                  <p>The file didn't contain the target plates.</p>
                  <button type="button" className="shortcut-dismiss-btn" onClick={() => setShortcutPopup(null)}>Dismiss</button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* ── Plus mode: choose ── */}
        {plusMode === "choose" ? (
          <div className="edit-backdrop" onClick={() => setPlusMode(null)} role="presentation">
            <div className="edit-modal" style={{ maxWidth: 340 }} onClick={(e) => e.stopPropagation()}>
              <div className="edit-modal-head">
                <strong>Add new row</strong>
                <button type="button" className="modal-x-btn" onClick={() => setPlusMode(null)}>✕</button>
              </div>
              <p className="modal-hint">How do you want to add the row?</p>
              <div className="edit-actions" style={{ flexDirection: "column", gap: 10 }}>
                <button type="button" className="choice-btn file" onClick={openFilePicker}>
                  <span className="choice-icon">📂</span>
                  <span className="choice-label">Import from file<small>Pick an Excel file to scan</small></span>
                </button>
                <button type="button" className="choice-btn manual" onClick={() => setPlusMode("manual")}>
                  <span className="choice-icon">✏️</span>
                  <span className="choice-label">Enter manually<small>Type the row details yourself</small></span>
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Plus mode: manual entry ── */}
        {plusMode === "manual" ? (
          <div className="edit-backdrop" onClick={() => setPlusMode(null)} role="presentation">
            <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
              <div className="edit-modal-head">
                <strong>New row</strong>
                <button type="button" className="modal-x-btn" onClick={() => setPlusMode(null)}>✕</button>
              </div>
              {manualError ? <div className="edit-error">{manualError}</div> : null}
              <div className="edit-fields">
                {[
                  { key: "license_plate", label: "License Plate *" },
                  { key: "arrival_code", label: "Arrival Code *" },
                  { key: "arrival_date", label: "Date", placeholder: "YYYY-MM-DD" },
                  { key: "batch_time", label: "Time", placeholder: "HH:MM" },
                  { key: "product_type", label: "Product Type" },
                  { key: "company", label: "Company" }
                ].map(({ key, label, placeholder }) => (
                  <div key={key} className="edit-field">
                    <label htmlFor={`manual-${key}`}>{label}</label>
                    <input
                      id={`manual-${key}`} type="text" value={manualFields[key] || ""} placeholder={placeholder || ""}
                      onChange={(e) => setManualFields((p) => ({ ...p, [key]: e.target.value }))}
                    />
                  </div>
                ))}
                <div className="edit-field">
                  <label>Payment status</label>
                  <div className="paid-toggle-row">
                    <button
                      type="button"
                      className={`paid-toggle-btn ${manualFields.paid ? "active" : ""}`}
                      onClick={() => setManualFields((p) => ({ ...p, paid: true }))}
                    >✓ Paid</button>
                    <button
                      type="button"
                      className={`paid-toggle-btn ${!manualFields.paid ? "active unpaid" : ""}`}
                      onClick={() => setManualFields((p) => ({ ...p, paid: false }))}
                    >— Unpaid</button>
                  </div>
                </div>
              </div>
              <div className="edit-actions">
                <button type="button" className="edit-btn cancel" onClick={() => setPlusMode(null)}>Cancel</button>
                <button type="button" className="edit-btn save" onClick={handleManualSave} disabled={manualSaving}>
                  {manualSaving ? "Saving…" : "Save row"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Context menu ── */}
        {contextMenu ? (
          <div className="ctx-backdrop" onClick={() => setContextMenu(null)} role="presentation">
            <div
              ref={contextMenuRef}
              className="ctx-menu"
              style={!isMobile ? { top: Math.min(contextMenu.y, window.innerHeight - 260), left: Math.min(contextMenu.x, window.innerWidth - 210) } : {}}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ctx-row-label">
                <span>{normalizeValue(contextMenu.row.arrival_code)}</span>
                <span>{normalizeValue(contextMenu.row.arrival_date)}</span>
              </div>
              <div className="ctx-divider" />
              <button type="button" className={`ctx-item ${contextMenu.row.paid ? "unpay" : "pay"}`}
                onClick={() => { setConfirmModal({ type: "paid", row: contextMenu.row }); setContextMenu(null); }}>
                {contextMenu.row.paid ? "— Mark as unpaid" : "✓ Mark as paid"}
              </button>
              <button type="button" className="ctx-item" onClick={() => openEditModal(contextMenu.row)}>✎ Edit row</button>
              <button type="button" className="ctx-item" onClick={() => { setSubdivideTarget(contextMenu.row); setSubdivideLabel(""); setContextMenu(null); }}>
                ⊟ Subdivide above
              </button>
              <div className="ctx-divider" />
              <button type="button" className="ctx-item danger"
                onClick={() => { setConfirmModal({ type: "delete", row: contextMenu.row }); setContextMenu(null); }}>
                ✕ Delete row
              </button>
              <div className="ctx-divider" />
              <button type="button" className="ctx-item muted" onClick={() => setContextMenu(null)}>Cancel</button>
            </div>
          </div>
        ) : null}

        {/* ── Confirm modal ── */}
        {confirmModal ? (
          <div className="edit-backdrop" onClick={() => setConfirmModal(null)} role="presentation">
            <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
              <div className={`confirm-icon ${confirmModal.type === "delete" || confirmModal.type === "deleteDivider" ? "danger" : confirmModal.row?.paid ? "unpay" : "pay"}`}>
                {confirmModal.type === "delete" || confirmModal.type === "deleteDivider" ? "✕" : confirmModal.row?.paid ? "—" : "✓"}
              </div>
              <strong>
                {confirmModal.type === "delete" || confirmModal.type === "deleteDivider"
                  ? "Delete this row?"
                  : confirmModal.row?.paid
                    ? "Mark as unpaid?"
                    : "Mark as paid?"}
              </strong>
              <p>
                {confirmModal.type === "delete" || confirmModal.type === "deleteDivider"
                  ? "This cannot be undone."
                  : `${normalizeValue(confirmModal.row?.arrival_code)} · ${normalizeValue(confirmModal.row?.arrival_date)}`}
              </p>
              <div className="edit-actions">
                <button type="button" className="edit-btn cancel" onClick={() => setConfirmModal(null)}>Cancel</button>
                <button
                  type="button"
                  className={`edit-btn save ${confirmModal.type === "delete" || confirmModal.type === "deleteDivider" ? "danger-btn" : "green-btn"}`}
                  onClick={handleConfirm}
                  disabled={confirmLoading}
                >
                  {confirmLoading ? "…" : confirmModal.type === "delete" || confirmModal.type === "deleteDivider" ? "Yes, delete" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Subdivide label input ── */}
        {subdivideTarget ? (
          <div className="edit-backdrop" onClick={() => setSubdivideTarget(null)} role="presentation">
            <div className="edit-modal" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
              <div className="edit-modal-head">
                <strong>Add divider above</strong>
                <button type="button" className="modal-x-btn" onClick={() => setSubdivideTarget(null)}>✕</button>
              </div>
              <p className="modal-hint">
                This will add a gray divider row above <strong>{normalizeValue(subdivideTarget.arrival_code)}</strong>.
              </p>
              <div className="edit-field">
                <label htmlFor="subdivide-label">Divider label</label>
                <input
                  id="subdivide-label" type="text" placeholder="e.g. After payment · 2,748,000"
                  value={subdivideLabel}
                  onChange={(e) => setSubdivideLabel(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="edit-actions">
                <button type="button" className="edit-btn cancel" onClick={() => setSubdivideTarget(null)}>Cancel</button>
                <button type="button" className="edit-btn save" onClick={handleSubdivideSubmit} disabled={subdivideSaving || !subdivideLabel.trim()}>
                  {subdivideSaving ? "Saving…" : "Add divider"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Edit modal ── */}
        {editRow ? (
          <div className="edit-backdrop" onClick={closeEditModal} role="presentation">
            <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
              <div className="edit-modal-head">
                <strong>Edit row</strong>
                <button type="button" className="modal-x-btn" onClick={closeEditModal}>✕</button>
              </div>
              {editError ? <div className="edit-error">{editError}</div> : null}
              <div className="edit-fields">
                {[
                  { key: "license_plate", label: "License Plate" },
                  { key: "arrival_code", label: "Arrival Code" },
                  { key: "arrival_date", label: "Date", placeholder: "YYYY-MM-DD" },
                  { key: "batch_time", label: "Time", placeholder: "HH:MM" },
                  { key: "product_type", label: "Product Type" },
                  { key: "company", label: "Company" }
                ].map(({ key, label, placeholder }) => (
                  <div key={key} className="edit-field">
                    <label htmlFor={`edit-${key}`}>{label}</label>
                    <input id={`edit-${key}`} type="text" value={editFields[key] || ""} placeholder={placeholder || ""}
                      onChange={(e) => setEditFields((p) => ({ ...p, [key]: e.target.value }))} />
                  </div>
                ))}
              </div>
              <div className="edit-actions">
                <button type="button" className="edit-btn cancel" onClick={closeEditModal}>Cancel</button>
                <button type="button" className="edit-btn save" onClick={handleEditSave} disabled={editSaving}>
                  {editSaving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Scan result banner (desktop only) ── */}
        {scanState === "found" ? (
          <div className="scan-result found desktop-only" role="status" aria-live="polite">
            <div className="scan-icon">✓</div>
            <div className="scan-body">
              <strong>{targetRows.length} match{targetRows.length === 1 ? "" : "es"} found</strong>
              <span>{targetRows.map((r) => `${formatPlateLabel(r.license_plate)} · ${normalizeValue(r.arrival_code)}`).join("   ")}</span>
            </div>
            <button type="button" className="scan-save-btn" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        ) : scanState === "not_found" ? (
          <div className="scan-result not-found desktop-only" role="alert">
            <div className="scan-icon not-found-x">✕</div>
            <div className="scan-body"><strong>No matches found</strong><span>Target plates not in this file.</span></div>
          </div>
        ) : scanState === "saved" ? (
          <div className="scan-result saved desktop-only" role="status">
            <div className="scan-icon">✓</div>
            <div className="scan-body"><strong>Saved successfully</strong><span>{notice}</span></div>
          </div>
        ) : null}

        {/* ── Main card ── */}
        <section className="card table-shell">
          <div className="card-head">
            <div>
              <h2>Saved arrivals</h2>
              <p className="table-note">Hold or right-click a row to edit</p>
            </div>
            <button type="button" className="small-button" onClick={() => loadAll().catch((err) => setError(err.message))}>Refresh</button>
          </div>

          {error ? (
            <div className="message-banner error" role="alert" aria-live="assertive">
              <span>{error}</span>
              <button type="button" className="banner-close" onClick={clearError}>✕</button>
            </div>
          ) : null}

          <div className="plate-toggle" role="tablist" aria-label="Target plates">
            {TARGET_LICENSE_PLATES.map((plate) => (
              <button key={plate} type="button" role="tab"
                aria-selected={normalizePlate(selectedPlate) === normalizePlate(plate)}
                className={normalizePlate(selectedPlate) === normalizePlate(plate) ? "active" : ""}
                onClick={() => setSelectedPlate(plate)}>
                <span>{formatPlateLabel(plate)}</span>
                <small>{visibleRows.filter((r) => normalizePlate(r.license_plate) === normalizePlate(plate)).length} saved</small>
              </button>
            ))}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="th-num">#</th>
                  <th className="th-paid">Paid</th>
                  <th>Code</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th className="th-hide-mobile">Product</th>
                  <th className="th-hide-mobile">Company</th>
                </tr>
              </thead>
              <tbody>
                {mergedRows.length ? mergedRows.map((item) => {
                  if (item.__type === "divider") {
                    return (
                      <tr key={`div-${item.id}`} className="divider-row">
               <td colSpan="7" className="divider-cell">
                          <div className="divider-inner">
                            <span className="divider-label">{item.label}</span>
                            <button
                              type="button"
                              className="divider-delete-btn"
                              onClick={() => setConfirmModal({ type: "deleteDivider", row: item })}
                              title="Remove divider"
                            >✕</button>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  const idx = rowIndex++;
                  return (
                    <tr
                      key={item.id}
                      className={[highlightedIds.has(item.id) ? "row-highlight" : "", item.paid ? "row-paid" : ""].filter(Boolean).join(" ")}
                      onContextMenu={(e) => openContextMenu(e, item)}
                      onTouchStart={(e) => handleRowTouchStart(e, item)}
                      onTouchEnd={handleRowTouchEnd}
                      onTouchMove={handleRowTouchEnd}
                    >
                      <td className="td-num">{idx + 1}</td>
                      <td className="td-paid">
                        <span className={`paid-badge ${item.paid ? "paid" : "unpaid"}`}>{item.paid ? "✓" : "—"}</span>
                      </td>
                      <td className="td-code">{normalizeValue(item.arrival_code)}</td>
                      <td className="td-date">{normalizeValue(item.arrival_date)}</td>
                      <td className="td-time">{normalizeValue(item.batch_time)}</td>
                      <td className="th-hide-mobile">{normalizeValue(item.product_type)}</td>
                      <td className="th-hide-mobile">{normalizeValue(item.company)}</td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan="7" className="empty-cell">No saved rows for {formatPlateLabel(selectedPlate)}.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ── Hidden file input ── */}
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
        onChange={(e) => void handleFileSelected(e.target.files?.[0] || null)} />

      {/* ── Desktop loading overlay ── */}
      {loading && !isMobile ? (
        <div className="status-overlay" aria-live="polite">
          <div className="status-card">
            <div className="spinner" />
            <strong>Finding target plates</strong>
            <p>Reading the file and scanning for matches.</p>
          </div>
        </div>
      ) : null}

      {/* ── FAB ── */}
      <button type="button" className="floating-plus" onClick={() => setPlusMode("choose")} aria-label="Add row">+</button>

      {showTopButton ? (
        <button type="button" className="floating-top" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Scroll to top">↑</button>
      ) : null}

      {/* ── Mobile sheet (file import status) ── */}
      {isMobile && mobileStatus !== "idle" && file ? (
        <div className="mobile-sheet-backdrop" onClick={resetScanState} role="presentation">
          <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-sheet-head">
              <strong>Import</strong>
              <button type="button" className="sheet-close" onClick={resetScanState}>✕</button>
            </div>
            <div className={`sheet-status ${mobileStatus}`}>
              {mobileStatus === "loading" ? (<><div className="spinner" /><strong>Scanning file…</strong></>)
                : mobileStatus === "found" ? (
                  <>
                    <div className="sheet-state-icon found-icon">✓</div>
                    <strong>{targetRows.length} match{targetRows.length === 1 ? "" : "es"} found</strong>
                    <div className="sheet-preview">
                      {targetRows.map((row, i) => (
                        <div key={i} className="sheet-preview-row">
                          <div className="sheet-preview-row-head">
                            <strong>{formatPlateLabel(row.license_plate)}</strong>
                            <span>Match {i + 1}</span>
                          </div>
                          <div className="sheet-preview-meta">
                            <div><b>Code</b><span>{normalizeValue(row.arrival_code)}</span></div>
                            <div><b>Date</b><span>{normalizeValue(row.arrival_date)}</span></div>
                            <div><b>Time</b><span>{normalizeValue(row.batch_time)}</span></div>
                            <div><b>Product</b><span>{normalizeValue(row.product_type)}</span></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : mobileStatus === "saved" ? (<><div className="sheet-state-icon found-icon">✓</div><strong>Saved successfully</strong></>)
                  : (<><div className="sheet-state-icon not-found-icon">✕</div><strong>No matches found</strong></>)}
            </div>
            {mobileStatus === "found" ? (
              <button type="button" className="sheet-action green" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save rows"}
              </button>
            ) : null}
            <button type="button" className="sheet-action" onClick={resetScanState}>Dismiss</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
