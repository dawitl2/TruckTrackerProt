import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import "./App.css";

const TARGET_LICENSE_PLATES = ["A33233/40337", "A21457/37737"];
const TARGET_LICENSE_PLATE_SET = new Set(TARGET_LICENSE_PLATES.map(normalizePlate));
const SUPABASE_URL = "https://ceaznmvgerreomiklcwo.supabase.co";
const SUPABASE_KEY = "sb_publishable_kF30JdMpqmsM9VmXPZLYAw_i8V58YJJ";
const SUPABASE_TABLE = "truck_arrivals";

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra
  };
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  if (text.includes("<!DOCTYPE")) throw new Error("A server returned HTML instead of JSON. Check the request URL.");
  throw new Error(text || "Unexpected non-JSON response from the server.");
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
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
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
      arrival_date: extractionDate,
      batch_time: extractionTime,
      license_plate: String(row[1] || "").trim(),
      arrival_code: String(row[2] || "").trim(),
      product_type: String(row[3] || "").trim(),
      company: String(row[4] || "").trim()
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
    reader.onload = (event) => {
      try {
        const workbook = XLSX.read(event.target.result, { type: "binary" });
        resolve(workbook);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsBinaryString(file);
  });
}

async function parseBatchFile(file) {
  const workbook = await readWorkbook(file);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("The workbook does not contain any sheets.");
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!matrix.length) throw new Error("No data rows were found in the file.");
  const now = new Date();
  const parsed = parseRows(matrix, formatExtractionDate(now), formatExtractionTime(now));
  if (!parsed.rows.length) throw new Error("No arrival rows were found in the file.");
  return parsed;
}

function App() {
  const [file, setFile] = useState(null);
  const [savedRows, setSavedRows] = useState([]);
  const [selectedPlate, setSelectedPlate] = useState(TARGET_LICENSE_PLATES[0]);
  const [targetRows, setTargetRows] = useState([]);
  const [saveComplete, setSaveComplete] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [showTopButton, setShowTopButton] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  const clearNotice = () => setNotice("");
  const clearError = () => setError("");

  // Reset all scan state back to idle
  const resetScanState = () => {
    setFile(null);
    setTargetRows([]);
    setSaveComplete(false);
    setLoading(false);
    setSaving(false);
    clearNotice();
    clearError();
    // Reset the file input so the same file can be picked again later
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const loadSavedRows = async () => {
    let response;
    try {
      response = await fetch(
        `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?select=id,arrival_date,batch_time,license_plate,arrival_code,product_type,company,created_at&order=created_at.desc&limit=50`,
        { headers: supabaseHeaders() }
      );
    } catch {
      throw new Error("Could not reach Supabase.");
    }
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error?.message || data.message || "Failed to load saved rows");
    setSavedRows(data || []);
  };

  useEffect(() => {
    loadSavedRows().catch((loadError) => setError(loadError.message));
  }, []);

  useEffect(() => {
    const updateViewport = () => setIsMobile(window.innerWidth <= 720);
    const updateScroll = () => setShowTopButton(window.scrollY > 280);
    updateViewport();
    updateScroll();
    window.addEventListener("resize", updateViewport);
    window.addEventListener("scroll", updateScroll, { passive: true });
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("scroll", updateScroll);
    };
  }, []);

  const openFilePicker = () => fileInputRef.current?.click();

  const handlePrimaryAction = () => {
    if (isMobile) {
      setMobileSheetOpen((current) => !current);
      return;
    }
    openFilePicker();
  };

  // Cancel: close sheet AND wipe all scan state so reopening shows "Ready"
  const closeMobileSheet = () => {
    setMobileSheetOpen(false);
    resetScanState();
  };

  const handleFileSelected = async (nextFile) => {
    if (!nextFile) return;
    setFile(nextFile);
    setLoading(true);
    setSaving(false);
    clearNotice();
    clearError();
    setSelectedPlate(TARGET_LICENSE_PLATES[0]);
    setTargetRows([]);
    setSaveComplete(false);
    try {
      const parsed = await parseBatchFile(nextFile);
      setTargetRows(parsed.targetRows);
      setSelectedPlate(parsed.targetRows[0]?.license_plate || TARGET_LICENSE_PLATES[0]);
      if (!parsed.targetRows.length) {
        setError("No target plates were found in the file.");
      } else {
        setNotice(`Found ${parsed.targetRows.length} target plate${parsed.targetRows.length === 1 ? "" : "s"}.`);
      }
    } catch (importError) {
      setError(importError.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!targetRows.length) return;
    setSaving(true);
    clearNotice();
    clearError();
    try {
      const payload = targetRows.map((row) => ({
        arrival_date: toDbValue(row.arrival_date),
        batch_time: toDbValue(row.batch_time),
        license_plate: String(row.license_plate || "").trim(),
        arrival_code: String(row.arrival_code || "").trim(),
        product_type: toDbValue(row.product_type),
        company: toDbValue(row.company)
      }));
      let response;
      try {
        response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
          method: "POST",
          headers: supabaseHeaders({
            "Content-Type": "application/json",
            Prefer: "return=representation"
          }),
          body: JSON.stringify(payload)
        });
      } catch {
        throw new Error("Could not reach Supabase.");
      }
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error?.message || data.message || "Save failed");
      const nextSelectedPlate = normalizePlate(payload[0]?.license_plate || selectedPlate);
      setSelectedPlate(nextSelectedPlate);
      setTargetRows([]);
      setSaveComplete(true);
      setNotice(`Saved ${payload.length} target plate${payload.length === 1 ? "" : "s"}.`);
      await loadSavedRows();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const visibleRows = savedRows.filter((row) => TARGET_LICENSE_PLATE_SET.has(normalizePlate(row.license_plate)));
  const plateRows = visibleRows.filter((row) => normalizePlate(row.license_plate) === normalizePlate(selectedPlate));
  const selectedPlateLabel = formatPlateLabel(selectedPlate);

  // desktop scan result state: null = idle, 'found' | 'not_found'
  const scanState = !file ? null : loading ? "loading" : targetRows.length && !saveComplete ? "found" : saveComplete ? "saved" : file ? "not_found" : null;

  const mobileStatus = loading
    ? "loading"
    : saveComplete
      ? "saved"
      : targetRows.length
        ? "found"
        : file
          ? "not_found"
          : "idle";

  return (
    <div className="page">
      <div className="shell">

        {/* ── Header: logo only, centered ── */}
        <header className="topbar">
          <img className="brand-logo" src="/logo.png" alt="Truck Tracker logo" />
        </header>

        {/* ── Scan result banner (desktop only — hidden on mobile via CSS) ── */}
        {scanState === "found" ? (
          <div className="scan-result found desktop-only" role="status" aria-live="polite">
            <div className="scan-icon">✓</div>
            <div className="scan-body">
              <strong>{targetRows.length} match{targetRows.length === 1 ? "" : "es"} found</strong>
              <span>
                {targetRows.map((row) =>
                  `${formatPlateLabel(row.license_plate)} · ${normalizeValue(row.arrival_code)} · ${normalizeValue(row.arrival_date)} · ${normalizeValue(row.batch_time)}`
                ).join("   ")}
              </span>
            </div>
            <button
              type="button"
              className="scan-save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : scanState === "not_found" ? (
          <div className="scan-result not-found desktop-only" role="alert">
            <div className="scan-icon not-found-x">✕</div>
            <div className="scan-body">
              <strong>No matches found</strong>
              <span>The target plates were not present in this file.</span>
            </div>
          </div>
        ) : scanState === "saved" ? (
          <div className="scan-result saved desktop-only" role="status">
            <div className="scan-icon">✓</div>
            <div className="scan-body">
              <strong>Saved successfully</strong>
              <span>{notice}</span>
            </div>
          </div>
        ) : null}

        {/* ── Main card ── */}
        <section className="card table-shell">
          <div className="card-head">
            <div>
              <h2>Saved arrivals</h2>
              <p className="table-note">Loaded from the `truck_arrivals` table.</p>
            </div>
            <button
              type="button"
              className="small-button"
              onClick={() => loadSavedRows().catch((err) => setError(err.message))}
            >
              Refresh
            </button>
          </div>

          {error ? (
            <div className="message-banner error" role="alert" aria-live="assertive">
              <span>{error}</span>
              <button type="button" className="banner-close" onClick={clearError} aria-label="Dismiss error">✕</button>
            </div>
          ) : null}

          <div className="plate-toggle" role="tablist" aria-label="Target plates">
            {TARGET_LICENSE_PLATES.map((plate) => (
              <button
                key={plate}
                type="button"
                role="tab"
                aria-selected={normalizePlate(selectedPlate) === normalizePlate(plate)}
                className={normalizePlate(selectedPlate) === normalizePlate(plate) ? "active" : ""}
                onClick={() => setSelectedPlate(plate)}
              >
                <span>{formatPlateLabel(plate)}</span>
                <small>
                  {visibleRows.filter((row) => normalizePlate(row.license_plate) === normalizePlate(plate)).length} saved
                </small>
              </button>
            ))}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Code</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Product</th>
                  <th>Company</th>
                </tr>
              </thead>
              <tbody>
                {plateRows.length ? (
                  plateRows.map((row, index) => (
                    <tr key={row.id}>
                      <td>{index + 1}</td>
                      <td>{normalizeValue(row.arrival_code)}</td>
                      <td>{normalizeValue(row.arrival_date)}</td>
                      <td>{normalizeValue(row.batch_time)}</td>
                      <td>{normalizeValue(row.product_type)}</td>
                      <td>{normalizeValue(row.company)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="6" className="empty-cell">
                      No saved rows for {selectedPlateLabel}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ── Hidden file input ── */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: "none" }}
        onChange={(event) => void handleFileSelected(event.target.files?.[0] || null)}
      />

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

      {/* ── FABs ── */}
      <button
        type="button"
        className="floating-plus"
        onClick={handlePrimaryAction}
        aria-label={isMobile ? "Open actions" : "Choose file"}
        title={isMobile ? "Open actions" : "Choose file"}
      >
        {isMobile && mobileSheetOpen ? "✕" : "+"}
      </button>

      {isMobile && showTopButton ? (
        <button
          type="button"
          className="floating-top"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Scroll to top"
          title="Scroll to top"
        >
          ↑
        </button>
      ) : null}

      {/* ── Mobile sheet ── */}
      {isMobile && mobileSheetOpen ? (
        <div className="mobile-sheet-backdrop" onClick={closeMobileSheet} role="presentation">
          <div className="mobile-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="mobile-sheet-head">
              <strong>Truck Tracker</strong>
              <button type="button" className="sheet-close" onClick={closeMobileSheet} aria-label="Close actions">✕</button>
            </div>

            <div className={`sheet-status ${mobileStatus}`}>
              {mobileStatus === "loading" ? (
                <>
                  <div className="spinner" />
                  <strong>Loading file</strong>
                  <p>Reading the spreadsheet and checking every target match.</p>
                </>
              ) : mobileStatus === "found" ? (
                <>
                  <div className="sheet-state-icon found-icon">✓</div>
                  <strong>{targetRows.length} match{targetRows.length === 1 ? "" : "es"} found</strong>
                  <p>These are the exact rows that matched the target plates.</p>
                  <div className="sheet-preview">
                    {targetRows.map((row, index) => (
                      <div
                        key={`${row.license_plate}-${row.arrival_code}-${row.arrival_date}-${row.batch_time}-${index}`}
                        className="sheet-preview-row"
                      >
                        <div className="sheet-preview-row-head">
                          <strong>{formatPlateLabel(row.license_plate)}</strong>
                          <span>Match {index + 1}</span>
                        </div>
                        <div className="sheet-preview-meta">
                          <div><b>Code</b><span>{normalizeValue(row.arrival_code)}</span></div>
                          <div><b>Date</b><span>{normalizeValue(row.arrival_date)}</span></div>
                          <div><b>Time</b><span>{normalizeValue(row.batch_time)}</span></div>
                          <div><b>Product</b><span>{normalizeValue(row.product_type)}</span></div>
                          <div><b>Company</b><span>{normalizeValue(row.company)}</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : mobileStatus === "saved" ? (
                <>
                  <div className="sheet-state-icon found-icon">✓</div>
                  <strong>Saved successfully</strong>
                  <p>The target rows were written to the database.</p>
                </>
              ) : mobileStatus === "not_found" ? (
                <>
                  <div className="sheet-state-icon not-found-icon">✕</div>
                  <strong>No matches found</strong>
                  <p>The target plates were not present in this file.</p>
                </>
              ) : (
                <>
                  <strong>Ready</strong>
                  <p>Choose a file to start the import.</p>
                </>
              )}
            </div>

            <button type="button" className="sheet-action" onClick={openFilePicker}>
              Choose file
            </button>

            {mobileStatus === "found" ? (
              <button
                type="button"
                className="sheet-action green"
                onClick={handleSave}
                disabled={!targetRows.length || saving}
              >
                {saving ? "Saving…" : "Save target rows"}
              </button>
            ) : null}

            <button type="button" className="sheet-action" onClick={closeMobileSheet}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;