import { useState, useCallback, useRef, useEffect } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { motion, AnimatePresence } from "framer-motion";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface UploadResult {
  filename: string;
  rows_inserted: number;
  rows_updated?: number;
  rows_duplicate_in_file?: number;
  rows_skipped_summary: number;
  rows_failed: number;
  errors: string[];
  info?: string[];
  status: string;
}

interface HistoryItem {
  id: string;
  filename: string;
  rows_total: number;
  rows_success: number;
  rows_failed: number;
  status: string;
  uploaded_at: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function LeadsUploadTab({ onUploaded }: { onUploaded?: () => void }) {
  const { token, user } = useAuth();
  const canDelete = user?.role === "superadmin" || user?.role === "leads_head";
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/leads/upload-history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
        setHistoryLoaded(true);
      }
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const deleteUpload = async (h: HistoryItem) => {
    if (!window.confirm(`Delete upload "${h.filename}" and the leads it added? This cannot be undone.`)) return;
    const res = await fetch(`${API_URL}/leads/uploads/${h.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert(data.detail || "Delete failed");
      return;
    }
    loadHistory();
    onUploaded?.();
  };

  const handleFile = (f: File) => {
    if (!f.name.match(/\.(xlsx|xls|csv)$/i)) {
      alert("Only .xlsx, .xls, or .csv files are accepted");
      return;
    }
    setFile(f);
    setResult(null);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch(`${API_URL}/leads/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      setResult(data);
      setFile(null);
      loadHistory();
      onUploaded?.();
    } catch (err: any) {
      setResult({
        filename: file.name,
        rows_inserted: 0,
        rows_skipped_summary: 0,
        rows_failed: 1,
        errors: [err.message],
        status: "Error",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`
          relative border-2 border-dashed rounded-3xl p-12 text-center cursor-pointer transition-all duration-200
          ${dragging
            ? "border-orange-400 bg-orange-50"
            : file
            ? "border-green-400 bg-green-50"
            : "border-orange-200 bg-orange-50/30 hover:bg-orange-50 hover:border-orange-300"}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />

        <AnimatePresence mode="wait">
          {file ? (
            <motion.div
              key="file"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex flex-col items-center gap-3"
            >
              <FileSpreadsheet className="w-12 h-12 text-green-500" />
              <p className="font-semibold text-gray-800">{file.name}</p>
              <p className="text-sm text-gray-500">
                {(file.size / 1024).toFixed(1)} KB — ready to upload
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3"
            >
              <div className="w-16 h-16 rounded-2xl bg-orange-100 flex items-center justify-center">
                <Upload className="w-7 h-7 text-orange-500" />
              </div>
              <div>
                <p className="font-semibold text-gray-700">Drop your file here</p>
                <p className="text-sm text-gray-500 mt-0.5">or click to browse</p>
              </div>
              <p className="text-xs text-gray-500 bg-white/60 px-3 py-1 rounded-full border border-orange-100">
                Supports: .xlsx · .xls · .csv
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Upload button */}
      <AnimatePresence>
        {file && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex gap-3"
          >
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="flex-1 py-3.5 rounded-2xl bg-gradient-to-r from-orange-500 to-orange-600 text-white font-semibold hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-200 shadow-lg shadow-orange-200 flex items-center justify-center gap-2"
            >
              {uploading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Uploading & Processing…
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Upload File
                </>
              )}
            </button>
            <button
              onClick={() => { setFile(null); setResult(null); }}
              className="px-5 py-3.5 rounded-2xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium transition"
            >
              Cancel
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Result card */}
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`rounded-2xl border p-5 ${
              result.status !== "Failed" && result.rows_failed === 0
                ? "bg-green-50 border-green-200"
                : "bg-amber-50 border-amber-200"
            }`}
          >
            <div className="flex items-start gap-4">
              {result.status !== "Failed" && result.rows_failed === 0 ? (
                <CheckCircle2 className="w-6 h-6 text-green-500 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />
              )}
              <div className="flex-1">
                <p className="font-semibold text-gray-800">{result.filename}</p>
                <div className="flex flex-wrap gap-4 mt-2 text-sm">
                  <span className="text-green-700 font-medium">
                    ✅ {result.rows_inserted} new leads
                  </span>
                  {(result.rows_updated ?? 0) > 0 && (
                    <span className="text-blue-600 font-medium">
                      🔄 {result.rows_updated} existing leads updated
                    </span>
                  )}
                  {(result.rows_duplicate_in_file ?? 0) > 0 && (
                    <span className="text-gray-600 font-medium">
                      ⧉ {result.rows_duplicate_in_file} repeated rows in file merged
                    </span>
                  )}
                  {result.rows_skipped_summary > 0 && (
                    <span className="text-blue-600 font-medium">
                      ⏭ {result.rows_skipped_summary} summary rows skipped
                    </span>
                  )}
                  {result.rows_failed > 0 && (
                    <span className="text-red-600 font-medium">
                      ❌ {result.rows_failed} rows failed
                    </span>
                  )}
                </div>
                {(result.info ?? []).filter((m) => !m.includes("summary")).map((m, i) => (
                  <p key={i} className="mt-2 text-xs text-gray-600">{m}</p>
                ))}
                {result.errors.length > 0 && (
                  <div className="mt-3">
                    <button
                      onClick={() => setShowErrors(!showErrors)}
                      className="text-xs text-amber-700 font-medium flex items-center gap-1 hover:underline"
                    >
                      {showErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {showErrors ? "Hide" : "Show"} details ({result.errors.length})
                    </button>
                    {showErrors && (
                      <ul className="mt-2 space-y-0.5 text-xs text-red-700 bg-white/60 rounded-xl p-3">
                        {result.errors.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload history */}
      <div>
        <h2 className="text-base font-bold text-gray-800 mb-3">Upload History</h2>
        {!historyLoaded ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : history.length === 0 ? (
          <div className="text-sm text-gray-500 bg-gray-50 rounded-2xl p-6 text-center">
            No uploads yet. Upload your first file above.
          </div>
        ) : (
          <div className="bg-white border border-orange-100 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-orange-50 bg-orange-50/40">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">File</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Rows saved</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Failed</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Date</th>
                  {canDelete && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.id} className={i % 2 === 0 ? "bg-white" : "bg-orange-50/20"}>
                    <td className="px-4 py-3 flex items-center gap-2 text-gray-700">
                      <FileSpreadsheet className="w-4 h-4 text-orange-400 shrink-0" />
                      <span className="truncate max-w-[200px]">{h.filename}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-green-700 font-medium">{h.rows_success}</td>
                    <td className="px-4 py-3 text-right text-red-600 font-medium">{h.rows_failed}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        h.status === "Done"
                          ? "bg-green-100 text-green-700"
                          : h.status === "Failed"
                          ? "bg-red-100 text-red-700"
                          : "bg-amber-100 text-amber-700"
                      }`}>
                        {h.status === "Done" ? <CheckCircle2 size={10} /> : h.status === "Failed" ? <XCircle size={10} /> : <Clock size={10} />}
                        {h.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(h.uploaded_at)}</td>
                    {canDelete && (
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => deleteUpload(h)} title="Delete this upload and its leads"
                          className="text-gray-400 hover:text-red-600 transition">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
