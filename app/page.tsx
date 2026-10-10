"use client";
// app/page.tsx
// npm i jspdf jspdf-autotable html-to-image qrcode && npm i -D @types/qrcode
// Fonts: copy the 3 files into  public/fonts/  (Poppins-Regular, Poppins-Italic, Poppins-SemiBold .ttf)
import { useEffect, useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import QRCode from "qrcode";

const SHOP = {
  name: "Nirmiti Electricals",
  tag: "Bright ideas, Brilliant service",
  owner: "Sachin Raut", // dummy - replace with the real owner name
  phones: ["+91 99604 78175", "+91 72195 71956"], // dummy - replace with real numbers
  gstin: "",
};
const MOBILE_RE = /^[6-9]\d{9}$/; // Indian mobile: 10 digits, starts with 6-9
const GST_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/; // 15-char GSTIN
// Fill these once if you want them pre-filled every time (nothing is stored by the app)
const DEFAULT_PAY = { upi: "", holder: "", bank: "", acc: "", ifsc: "" };

type DType = "pct" | "unit" | "total";
type Item = { id: number; name: string; qty: number; rate: number; disc: number; dtype: DType };

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function lineCalc(i: Item) {
  const gross = i.qty * i.rate;
  let d = i.dtype === "pct" ? (gross * i.disc) / 100 : i.dtype === "unit" ? i.disc * i.qty : i.disc;
  d = Math.min(Math.max(d || 0, 0), gross);
  return { gross, d, net: gross - d };
}

const blank = (id: number): Item => ({ id, name: "", qty: 1, rate: 0, disc: 0, dtype: "pct" });

/* ---------- Poppins for jsPDF (loaded from /public/fonts) ---------- */
let fontCache: Record<string, string> | null = null;
const toB64 = (buf: ArrayBuffer) => {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
async function loadFonts() {
  if (fontCache) return fontCache;
  const out: Record<string, string> = {};
  await Promise.all(
    ["Poppins-Regular", "Poppins-Italic", "Poppins-SemiBold"].map(async (f) => {
      const r = await fetch(`/fonts/${f}.ttf`);
      if (!r.ok) throw new Error("font missing");
      out[f] = toB64(await r.arrayBuffer());
    })
  );
  return (fontCache = out);
}

/* ---------- small UI helpers ---------- */
const inp =
  "w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-base outline-none transition focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10 sm:text-sm";
const lbl = "block text-xs font-medium text-neutral-500";
const card = "space-y-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm";

function Toggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set(!on)}
      className="flex w-full items-center justify-between py-1 text-left"
    >
      <span className="text-sm font-medium">{label}</span>
      <span className={`relative h-6 w-11 rounded-full transition ${on ? "bg-neutral-900" : "bg-neutral-300"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

export default function Page() {
  const [customer, setCustomer] = useState("");
  const [mobile, setMobile] = useState("");
  const [address, setAddress] = useState("");
  const [gst, setGst] = useState("");
  const [billNo, setBillNo] = useState("");
  const [date, setDate] = useState("");
  const [items, setItems] = useState<Item[]>([blank(1)]);
  const [oDisc, setODisc] = useState(0);
  const [oType, setOType] = useState<"pct" | "amt">("pct");

  // optional extras
  const [gstOn, setGstOn] = useState(false);
  const [gstRate, setGstRate] = useState(18);
  const [gstIncl, setGstIncl] = useState(false);
  const [sigOn, setSigOn] = useState(false);
  const [payOn, setPayOn] = useState(false);
  const [pay, setPay] = useState(DEFAULT_PAY);
  const [qr, setQr] = useState("");

  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState({ mobile: false, gst: false });
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [prevH, setPrevH] = useState(0);

  useEffect(() => {
    const n = new Date();
    const p = (x: number) => String(x).padStart(2, "0");
    setBillNo(`NE-${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`);
    setDate(n.toLocaleDateString("en-IN"));
    loadFonts().catch(() => {}); // warm up so sharing stays instant
  }, []);

  const rows = useMemo(() => items.filter((i) => i.name.trim() && i.qty > 0), [items]);

  const t = useMemo(() => {
    const sub = rows.reduce((s, i) => s + lineCalc(i).net, 0);
    const itemDisc = rows.reduce((s, i) => s + lineCalc(i).d, 0);
    let od = oType === "pct" ? (sub * oDisc) / 100 : oDisc;
    od = r2(Math.min(Math.max(od || 0, 0), sub));
    const after = r2(sub - od);
    let taxable = after, tax = 0;
    if (gstOn) {
      if (gstIncl) { taxable = r2(after / (1 + gstRate / 100)); tax = r2(after - taxable); }
      else { tax = r2((after * gstRate) / 100); }
    }
    const cgst = r2(tax / 2);
    const sgst = r2(tax - cgst);
    const grand = gstOn && !gstIncl ? r2(taxable + tax) : after;
    return { sub, itemDisc, od, taxable, cgst, sgst, tax, grand };
  }, [rows, oDisc, oType, gstOn, gstRate, gstIncl]);

  // UPI QR (optional)
  useEffect(() => {
    if (!payOn || !pay.upi.trim() || t.grand <= 0) return setQr("");
    const url = `upi://pay?pa=${encodeURIComponent(pay.upi.trim())}&pn=${encodeURIComponent(SHOP.name)}&am=${t.grand.toFixed(2)}&cu=INR&tn=${encodeURIComponent("Bill " + billNo)}`;
    QRCode.toDataURL(url, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(""));
  }, [payOn, pay.upi, t.grand, billNo]);

  // fit the 794px bill into any screen width
  useEffect(() => {
    const box = boxRef.current, bill = ref.current;
    if (!box || !bill) return;
    const fit = () => {
      const s = Math.min(1, box.clientWidth / 794);
      setScale(s);
      setPrevH(bill.offsetHeight * s);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    ro.observe(bill);
    return () => ro.disconnect();
  }, []);

  const upd = (id: number, patch: Partial<Item>) =>
    setItems((l) => l.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const fileBase = () =>
    `Bill_${(customer.trim() || "Customer").replace(/[^\w]+/g, "_")}_${billNo || "draft"}`;

  const mobileErr =
    mobile && !MOBILE_RE.test(mobile)
      ? mobile.length < 10 ? "Enter a 10 digit mobile number" : "Mobile number must start with 6, 7, 8 or 9"
      : "";
  const gstErr = gst && !GST_RE.test(gst) ? "Enter a valid 15 character GST number (e.g. 27ABCDE1234F1Z5)" : "";

  const hasPay = payOn && (pay.upi || pay.bank || pay.acc || pay.ifsc || pay.holder);

  /* ---------- PDF (real text, Poppins, auto multi-page) ---------- */
  async function buildPdf() {
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    let F = "helvetica", cur = "Rs.";
    try {
      const f = await loadFonts();
      const reg: [string, string][] = [["Poppins-Regular", "normal"], ["Poppins-Italic", "italic"], ["Poppins-SemiBold", "bold"]];
      reg.forEach(([name, style]) => {
        doc.addFileToVFS(`${name}.ttf`, f[name]);
        doc.addFont(`${name}.ttf`, "Poppins", style);
      });
      F = "Poppins"; cur = "₹";
    } catch { /* falls back to Helvetica + "Rs." */ }

    // left: shop name + tagline
    doc.setFont(F, "bold").setFontSize(22).text(SHOP.name, 14, 17);
    doc.setFont(F, "medium").setFontSize(10).text(SHOP.tag, 14, 23);
    // right: owner details
    const ownerLines = [SHOP.owner, ...SHOP.phones, ...(SHOP.gstin ? [`GSTIN: ${SHOP.gstin}`] : [])];
    doc.setFont(F, "normal").setFontSize(15);
    ownerLines.forEach((l, k) => {
      if (k === 0) doc.setFont(F, "bold"); else doc.setFont(F, "normal");
      doc.text(l, W - 14, 12 + k * 6, { align: "right" });
    });
    const top = Math.max(23, 12 + (ownerLines.length - 1) * 6);
    doc.setDrawColor(180).line(14, top + 4, W - 14, top + 4);
    doc.setFont(F, "normal").setFontSize(10);
    doc.text(`Bill No: ${billNo}`, 14, top + 11);
    doc.text(`Date: ${date}`, W - 14, top + 11, { align: "right" });
    let y = top + 19;
    doc.setFont(F, "bold").text(`Bill To: ${customer || "-"}`, 14, y);
    doc.setFont(F, "normal");
    if (mobile) doc.text(`Mobile: ${mobile}`, 14, (y += 5));
    if (gst) doc.text(`GSTIN: ${gst}`, 14, (y += 5));
    if (address) {
      const lines = doc.splitTextToSize(`Address: ${address}`, W - 28);
      doc.text(lines, 14, (y += 5));
      y += (lines.length - 1) * 4.5;
    }

    autoTable(doc, {
      startY: y + 6,
      head: [["#", "Item", "Qty", "Rate", "Discount", "Amount"]],
      body: rows.map((i, k) => {
        const c = lineCalc(i);
        return [k + 1, i.name, i.qty, money(i.rate), c.d ? money(c.d) : "-", money(c.net)];
      }),
      theme: "grid",
      styles: { font: F, fontSize: 9, cellPadding: 2.5, lineColor: [210, 210, 210] },
      headStyles: { fillColor: [25, 25, 25], textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 10 }, 2: { halign: "right", cellWidth: 16 },
        3: { halign: "right", cellWidth: 28 }, 4: { halign: "right", cellWidth: 28 },
        5: { halign: "right", cellWidth: 32 },
      },
      showHead: "everyPage",
      margin: { left: 14, right: 14, bottom: 20 },
    });

    const tw = 84;
    const trows: string[][] = [["Subtotal", `${cur} ${money(t.sub)}`]];
    if (t.od) trows.push(["Overall Discount", `- ${cur} ${money(t.od)}`]);
    if (gstOn) {
      trows.push(["Taxable Value", `${cur} ${money(t.taxable)}`]);
      trows.push([`CGST @ ${gstRate / 2}%`, `${cur} ${money(t.cgst)}`]);
      trows.push([`SGST @ ${gstRate / 2}%`, `${cur} ${money(t.sgst)}`]);
    }
    trows.push(["Grand Total", `${cur} ${money(t.grand)}`]);
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 4,
      body: trows,
      theme: "plain",
      tableWidth: tw,
      margin: { left: W - 14 - tw, bottom: 20 },
      styles: { font: F, fontSize: 10, cellPadding: 1.8 },
      columnStyles: { 1: { halign: "right" } },
      didParseCell: (d) => {
        if (d.row.index === trows.length - 1) {
          d.cell.styles.fontStyle = "bold";
          d.cell.styles.fontSize = 12;
        }
      },
    });

    // optional: payment details + signature
    if (hasPay || sigOn) {
      const payLines: string[] = [];
      if (pay.holder) payLines.push(`A/c Name: ${pay.holder}`);
      if (pay.bank) payLines.push(`Bank: ${pay.bank}`);
      if (pay.acc) payLines.push(`A/c No: ${pay.acc}`);
      if (pay.ifsc) payLines.push(`IFSC: ${pay.ifsc}`);
      if (pay.upi) payLines.push(`UPI: ${pay.upi}`);
      const payH = hasPay ? Math.max(payLines.length * 5 + 7, qr ? 34 : 0) : 0;
      const need = payH + (sigOn ? 30 : 0) + 6;
      let by = (doc as any).lastAutoTable.finalY + 10;
      if (by + need > H - 18) { doc.addPage(); by = 20; }
      if (hasPay) {
        doc.setFont(F, "bold").setFontSize(10).text("Payment Details", 14, by);
        doc.setFont(F, "normal").setFontSize(9);
        payLines.forEach((l, k) => doc.text(l, 14, by + 6 + k * 5));
        if (qr) doc.addImage(qr, "PNG", W - 14 - 30, by - 3, 30, 30);
      }
      if (sigOn) {
        const sy = by + payH + 22;
        doc.setDrawColor(120).line(W - 14 - 55, sy, W - 14, sy);
        doc.setFont(F, "bold").setFontSize(9).text(`For ${SHOP.name}`, W - 14 - 27.5, sy - 14, { align: "center" });
        doc.setFont(F, "normal").setFontSize(8).text("Authorised Signatory", W - 14 - 27.5, sy + 5, { align: "center" });
      }
    }

    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p).setFont(F, "normal").setFontSize(8).setTextColor(130);
      doc.text("Thank you for your business!", 14, H - 10);
      doc.text(`Page ${p} of ${n}`, W - 14, H - 10, { align: "right" });
    }
    return doc;
  }

  const pdfBlob = async () => (await buildPdf()).output("blob") as Blob;
  const imgBlob = async () => {
    const node = ref.current!;
    const url = await toPng(node, { pixelRatio: 2, backgroundColor: "#fff", width: 794, height: node.offsetHeight });
    return await (await fetch(url)).blob();
  };

  const save = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  async function run(kind: "pdf" | "img", mode: "download" | "share") {
    setTouched({ mobile: true, gst: true });
    if (mobileErr || gstErr) return alert(mobileErr || gstErr);
    if (!rows.length) return alert("Add at least one item.");
    setBusy(true);
    try {
      const blob = kind === "pdf" ? await pdfBlob() : await imgBlob();
      const name = `${fileBase()}.${kind === "pdf" ? "pdf" : "png"}`;
      if (mode === "download") return save(blob, name);
      const file = new File([blob], name, { type: blob.type });
      const text = `Bill from ${SHOP.name} - Total Rs. ${money(t.grand)}`;
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text }); // pick WhatsApp in the share sheet
      } else {
        save(blob, name); // desktop fallback: download, then attach manually in WhatsApp
        window.open(`https://wa.me/${MOBILE_RE.test(mobile) ? "91" + mobile : ""}?text=${encodeURIComponent(text)}`, "_blank");
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") alert("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded-xl px-3 py-2.5 text-sm font-medium transition active:scale-[0.98] disabled:opacity-50";

  return (
    <main className="min-h-screen bg-neutral-100 px-3 pb-44 pt-4 text-neutral-900 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8">
      <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[400px_minmax(0,1fr)] xl:grid-cols-[440px_minmax(0,1fr)]">
        {/* ---------------- FORM ---------------- */}
        <section className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold">{SHOP.name}</h1>
            <p className="text-sm text-neutral-500">Bill generator</p>
          </div>

          <div className={card}>
            <h2 className="text-sm font-semibold">Customer</h2>
            <input className={inp} placeholder="Customer name *" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <input
                  className={inp + (touched.mobile && mobileErr ? " !border-red-500" : "")}
                  inputMode="numeric" maxLength={10} placeholder="Mobile - 10 digits (optional)" value={mobile}
                  onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  onBlur={() => setTouched((x) => ({ ...x, mobile: true }))}
                />
                {touched.mobile && mobileErr && <p className="mt-1 text-xs text-red-600">{mobileErr}</p>}
              </div>
              <div>
                <input
                  className={inp + (touched.gst && gstErr ? " !border-red-500" : "")}
                  maxLength={15} placeholder="GST number (optional)" value={gst}
                  onChange={(e) => setGst(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 15))}
                  onBlur={() => setTouched((x) => ({ ...x, gst: true }))}
                />
                {touched.gst && gstErr && <p className="mt-1 text-xs text-red-600">{gstErr}</p>}
              </div>
            </div>
            <input className={inp} placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <label className={lbl}>Bill no<input className={inp} value={billNo} onChange={(e) => setBillNo(e.target.value)} /></label>
              <label className={lbl}>Date<input className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></label>
            </div>
          </div>

          <div className={card}>
            <h2 className="text-sm font-semibold">Items</h2>
            {items.map((i, k) => (
              <div key={i.id} className="space-y-2.5 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-900 text-xs text-white">{k + 1}</span>
                  <input className={inp} placeholder="Product name" value={i.name} onChange={(e) => upd(i.id, { name: e.target.value })} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className={lbl}>Qty
                    <input type="number" inputMode="decimal" min={0} className={inp} value={i.qty || ""} onChange={(e) => upd(i.id, { qty: +e.target.value })} />
                  </label>
                  <label className={lbl}>Rate (each)
                    <input type="number" inputMode="decimal" min={0} className={inp} value={i.rate || ""} onChange={(e) => upd(i.id, { rate: +e.target.value })} />
                  </label>
                  <label className={lbl}>Discount
                    <input type="number" inputMode="decimal" min={0} className={inp} value={i.disc || ""} onChange={(e) => upd(i.id, { disc: +e.target.value })} />
                  </label>
                </div>
                <select className={inp} value={i.dtype} onChange={(e) => upd(i.id, { dtype: e.target.value as DType })}>
                  <option value="pct">Discount in % </option>
                  <option value="unit">Discount in Rs per unit</option>
                  <option value="total">Discount in Rs on whole item</option>
                </select>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">₹{money(lineCalc(i).net)}</span>
                  {items.length > 1 && (
                    <button className="rounded-lg px-2 py-1 text-sm text-red-600 active:bg-red-50" onClick={() => setItems((l) => l.filter((x) => x.id !== i.id))}>Remove</button>
                  )}
                </div>
              </div>
            ))}
            <button className={btn + " w-full border border-dashed border-neutral-400 bg-white"} onClick={() => setItems((l) => [...l, blank(Date.now())])}>
              + Add item
            </button>
          </div>

          <div className={card}>
            <h2 className="text-sm font-semibold">Overall discount</h2>
            <div className="flex gap-2">
              <input type="number" inputMode="decimal" min={0} placeholder="0" className={inp} value={oDisc || ""} onChange={(e) => setODisc(+e.target.value)} />
              <select className={inp + " !w-28"} value={oType} onChange={(e) => setOType(e.target.value as "pct" | "amt")}>
                <option value="pct">%</option>
                <option value="amt">₹</option>
              </select>
            </div>
          </div>

          <div className={card}>
            <h2 className="text-sm font-semibold">Optional extras</h2>

            <Toggle on={gstOn} set={setGstOn} label="GST (CGST + SGST)" />
            {gstOn && (
              <div className="space-y-3 rounded-xl bg-neutral-50 p-3">
                <div className="flex flex-wrap gap-2">
                  {[5, 12, 18, 28].map((r) => (
                    <button key={r} type="button" onClick={() => setGstRate(r)}
                      className={`rounded-full border px-3 py-1 text-sm ${gstRate === r ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 bg-white"}`}>
                      {r}%
                    </button>
                  ))}
                  <input type="number" inputMode="decimal" className={inp + " !w-24 !py-1"} value={gstRate || ""} placeholder="Other %" onChange={(e) => setGstRate(+e.target.value)} />
                </div>
                <Toggle on={gstIncl} set={setGstIncl} label="Rates already include GST" />
                <p className="text-xs text-neutral-500">Split equally: CGST {gstRate / 2}% + SGST {gstRate / 2}%</p>
              </div>
            )}

            <div className="border-t border-neutral-100" />
            <Toggle on={payOn} set={setPayOn} label="Bank / UPI details" />
            {payOn && (
              <div className="space-y-2.5 rounded-xl bg-neutral-50 p-3">
                <input className={inp} placeholder="UPI ID (shows a QR code)" value={pay.upi} onChange={(e) => setPay({ ...pay, upi: e.target.value })} />
                <input className={inp} placeholder="Account holder name" value={pay.holder} onChange={(e) => setPay({ ...pay, holder: e.target.value })} />
                <input className={inp} placeholder="Bank name" value={pay.bank} onChange={(e) => setPay({ ...pay, bank: e.target.value })} />
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <input className={inp} inputMode="numeric" placeholder="Account number" value={pay.acc} onChange={(e) => setPay({ ...pay, acc: e.target.value })} />
                  <input className={inp} placeholder="IFSC" value={pay.ifsc} onChange={(e) => setPay({ ...pay, ifsc: e.target.value.toUpperCase() })} />
                </div>
              </div>
            )}

            <div className="border-t border-neutral-100" />
            <Toggle on={sigOn} set={setSigOn} label="Signature line" />
          </div>

          {/* actions: sticky bar on mobile, normal block on desktop */}
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-200 bg-white/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:static lg:rounded-2xl lg:border lg:p-4 lg:shadow-sm">
            <div className="mx-auto mb-2 flex max-w-xl items-baseline justify-between px-1 lg:max-w-none">
              <span className="text-xs text-neutral-500">Grand total</span>
              <span className="text-lg font-semibold">₹{money(t.grand)}</span>
            </div>
            <div className="mx-auto grid max-w-xl grid-cols-2 gap-2 lg:max-w-none">
              <button disabled={busy} className={btn + " bg-blue-800 cursor-pointer text-white"} onClick={() => run("pdf", "download")}>Download PDF</button>
              <button disabled={busy} className={btn + " bg-blue-800 cursor-pointer text-white"} onClick={() => run("img", "download")}>Download Image</button>
              <button disabled={busy} className={btn + " bg-green-600 cursor-pointer text-white"} onClick={() => run("pdf", "share")}>WhatsApp PDF</button>
              <button disabled={busy} className={btn + " bg-green-600 cursor-pointer text-white"} onClick={() => run("img", "share")}>WhatsApp Image</button>
            </div>
          </div>
        </section>

        {/* ---------------- PREVIEW (also the image export) ---------------- */}
        <section className="min-w-0 lg:sticky lg:top-8 lg:self-start">
          <p className="mb-2 text-sm font-semibold text-neutral-500">Preview</p>
          <div ref={boxRef} className="w-full overflow-hidden rounded-xl shadow-sm" style={{ height: prevH || undefined }}>
            <div style={{ width: 794, transform: `scale(${scale})`, transformOrigin: "top left" }}>
              <div ref={ref} className="w-[794px] bg-white p-10 text-neutral-900">
                <div className="flex items-end justify-between gap-6 border-b border-neutral-300 pb-4">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight">{SHOP.name}</h2>
                    <p className="mt-1 text-sm italic text-neutral-500">{SHOP.tag}</p>
                  </div>
                  <div className="text-right text-xs leading-5 text-neutral-600">
                    <p className="font-semibold text-neutral-900">{SHOP.owner}</p>
                    {SHOP.phones.map((p) => <p key={p}>{p}</p>)}
                    {SHOP.gstin && <p>GSTIN: {SHOP.gstin}</p>}
                  </div>
                </div>
                <div className="mt-5 flex justify-between text-sm">
                  <div className="space-y-0.5">
                    <p className="text-xs uppercase tracking-wide text-neutral-400">Bill to</p>
                    <p className="font-semibold">{customer || "—"}</p>
                    {mobile && <p>Mobile: {mobile}</p>}
                    {gst && <p>GSTIN: {gst}</p>}
                    {address && <p className="max-w-xs">{address}</p>}
                  </div>
                  <div className="space-y-0.5 text-right">
                    <p>Bill No: <b className="font-semibold">{billNo}</b></p>
                    <p>Date: {date}</p>
                  </div>
                </div>

                <table className="mt-6 w-full text-sm">
                  <thead>
                    <tr className="bg-neutral-900 text-left text-white">
                      <th className="p-2 font-medium">#</th><th className="p-2 font-medium">Item</th>
                      <th className="p-2 text-right font-medium">Qty</th><th className="p-2 text-right font-medium">Rate</th>
                      <th className="p-2 text-right font-medium">Discount</th><th className="p-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i, k) => {
                      const c = lineCalc(i);
                      return (
                        <tr key={i.id} className="border-b border-neutral-200">
                          <td className="p-2">{k + 1}</td><td className="p-2">{i.name}</td>
                          <td className="p-2 text-right">{i.qty}</td>
                          <td className="p-2 text-right">₹{money(i.rate)}</td>
                          <td className="p-2 text-right">{c.d ? `₹${money(c.d)}` : "-"}</td>
                          <td className="p-2 text-right font-medium">₹{money(c.net)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="ml-auto mt-5 w-80 space-y-1 text-sm">
                  <div className="flex justify-between"><span>Subtotal</span><span>₹{money(t.sub)}</span></div>
                  {t.od > 0 && <div className="flex justify-between"><span>Overall Discount</span><span>- ₹{money(t.od)}</span></div>}
                  {gstOn && (
                    <>
                      <div className="flex justify-between"><span>Taxable Value</span><span>₹{money(t.taxable)}</span></div>
                      <div className="flex justify-between text-neutral-600"><span>CGST @ {gstRate / 2}%</span><span>₹{money(t.cgst)}</span></div>
                      <div className="flex justify-between text-neutral-600"><span>SGST @ {gstRate / 2}%</span><span>₹{money(t.sgst)}</span></div>
                    </>
                  )}
                  <div className="flex justify-between border-t border-neutral-300 pt-2 text-lg font-semibold">
                    <span>Grand Total</span><span>₹{money(t.grand)}</span>
                  </div>
                </div>

                {(hasPay || sigOn) && (
                  <div className="mt-8 flex items-end justify-between gap-6">
                    <div className="text-xs leading-5">
                      {hasPay && (
                        <div className="flex items-start gap-4">
                          <div>
                            <p className="mb-1 text-sm font-semibold">Payment Details</p>
                            {pay.holder && <p>A/c Name: {pay.holder}</p>}
                            {pay.bank && <p>Bank: {pay.bank}</p>}
                            {pay.acc && <p>A/c No: {pay.acc}</p>}
                            {pay.ifsc && <p>IFSC: {pay.ifsc}</p>}
                            {pay.upi && <p>UPI: {pay.upi}</p>}
                          </div>
                          {qr && /* eslint-disable-next-line @next/next/no-img-element */ <img src={qr} alt="UPI QR" className="h-24 w-24" />}
                        </div>
                      )}
                    </div>
                    {sigOn && (
                      <div className="w-56 text-center text-xs">
                        <p className="mb-14 font-semibold">For {SHOP.name}</p>
                        <div className="border-t border-neutral-500 pt-1 text-neutral-600">Authorised Signatory</div>
                      </div>
                    )}
                  </div>
                )}
                <p className="mt-10 text-center text-xs text-neutral-400">Thank you for your business!</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}