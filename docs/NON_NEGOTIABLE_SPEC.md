# ADJUNG AI EDITORIAL ENGINE
# MASTER OPERATING PRINCIPLES & NON-NEGOTIABLE WORKFLOW

**Status:** LOCKED
**Purpose:** Kawalan utama pembangunan dan penggunaan Adjung AI Editorial Engine

---

# 1. MATLAMAT UTAMA

Adjung AI Editorial Engine dibina untuk menghasilkan terjemahan lengkap sesuatu karya:

- daripada aksara pertama sehingga aksara terakhir,
- dengan kehilangan makna yang minimum,
- mengekalkan suara dan niat pengarang,
- boleh diaudit,
- boleh disemak manusia,
- boleh dikembangkan kepada pelbagai bahasa.

Matlamat utama bukan menghasilkan terjemahan paling cepat.

Matlamat utama ialah:

> Menghasilkan terjemahan berkualiti tinggi dengan jumlah semakan manusia minimum yang masih mengekalkan kawalan editorial.

---

# 2. PRINSIP ASAS YANG TIDAK BOLEH DILANGGAR

## 2.1 AI bukan editor utama

AI hanya:

- menganalisis,
- mencadangkan,
- menghasilkan draf,
- membantu mencari risiko.

AI tidak boleh:

- menetapkan gaya buku,
- mengubah suara pengarang,
- membuat keputusan editorial,
- mencipta rule baharu tanpa kelulusan manusia.

---

## 2.2 Manusia menentukan maksud

Urutan wajib:

```
Pengarang
    ↓
Teks asal
    ↓
Pemahaman manusia
    ↓
Keputusan editorial
    ↓
AI membantu
```

Bukan:

```
AI output
    ↓
Dianggap benar
    ↓
Dijadikan rule
```

---

# 3. PERANAN SISTEM

Adjung Engine bukan mesin terjemahan automatik.

Ia ialah:

> Sistem pengurusan konteks, keputusan editorial, dan workflow AI.

Sistem bertanggungjawab untuk:

- menyimpan konteks buku,
- menjana prompt,
- mengurus batch,
- menyusun output chatbot,
- menyimpan sejarah,
- mengesan perubahan,
- mengawal gate.

Sistem TIDAK:

- memanggil AI secara automatik sebagai default,
- membuat keputusan bagi pihak editor,
- melangkau fasa.

---

# 4. MODEL PENGGUNAAN CHATBOT

Chatbot luar digunakan sebagai enjin bahasa.

Contoh:

- ChatGPT
- Claude
- Gemini
- Grok

Aliran:

```
Adjung Engine
      ↓
Jana Prompt
      ↓
User copy prompt + bahan
      ↓
Chatbot pilihan user
      ↓
User paste output kembali
      ↓
Adjung Engine susun
```

---

# 5. BOOK UNDERSTANDING PHASE (WAJIB)

Sebelum memproses unit terjemahan:

## Langkah 1

Sistem menjana Book Scan Prompt.

User menghantar:

```
Prompt
+
Fail buku penuh
```

kepada chatbot.

---

## Langkah 2

Chatbot menghasilkan:

BOOK PROFILE

Mengandungi:

- genre,
- tujuan karya,
- sasaran pembaca,
- suara pengarang,
- gaya bahasa,
- struktur hujah,
- istilah penting,
- risiko terjemahan,
- cadangan pemprosesan.

---

## Langkah 3

User masukkan Book Profile kembali ke sistem.

Book Profile mesti diluluskan manusia sebelum digunakan.

---

# 6. PEMECAHAN UNIT

Selepas Book Profile tersedia:

Barulah sistem menentukan:

- saiz unit,
- cara pecahan,
- hubungan heading,
- RTL/LTR,
- format,
- quotation handling.

Unit bukan sekadar potongan teks.

Setiap unit mesti menyimpan:

```
Original Text
+
Formatting
+
Footnotes
+
Metadata
+
Memory berkaitan
```

---

# 7. WORKFLOW TERJEMAHAN WAJIB

## FASA 1 — PARAFRASA SAHAJA

Tujuan:

Memastikan AI memahami maksud.

Input:

- teks asal,
- Book Profile,
- relevant memory.

Output:

- parafrasa,
- nota keraguan.

TIADA:

- terjemahan,
- back translation.

---

## FASA 1 REVIEW

Semakan berlaku dalam Adjung Engine.

Paparan:

```
Original
+
AI Paraphrase
+
AI Notes
```

Editor boleh:

- approve,
- edit,
- reject.

Translation TIDAK BOLEH bermula sebelum parafrasa diluluskan.

---

# FASA 2 — TERJEMAHAN

Input:

WAJIB:

1. Teks asal
2. Parafrasa yang telah diluluskan
3. Book Profile
4. Relevant Decision Memory

Output:

- terjemahan bahasa sasaran.

---

# FASA 3 — BACK TRANSLATION

Tujuan:

Bukan membetulkan.

Tujuan:

Menjadi cermin untuk mengesan drift.

Arahan wajib:

- literal,
- jangan memperbaiki,
- jangan menafsir semula.

---

# FASA 4 — REVIEW AKHIR

Semakan:

- original,
- approved paraphrase,
- translation,
- back translation,
- attention points.

---

# 8. MEMORY SYSTEM

Terdapat tiga jenis memory.

## A. Book Profile

Konteks seluruh buku.

Contoh:

- genre,
- suara,
- gaya.

---

## B. Decision Memory

Keputusan editorial yang telah diluluskan.

Contoh:

```
tawaqquf:
kekalkan istilah Arab
```

---

## C. Unit Memory

Nota khusus perenggan.

Contoh:

```
BN-PRA-005:
jangan terbalikkan maksud bersepakat
```

---

# 9. CONTEXT RETRIEVAL

Jangan masukkan semua memory ke prompt.

Sistem mesti memilih hanya yang relevan.

Contoh:

Jika teks tiada "imam":

JANGAN masukkan rule imam.

Jika teks ada "tawaqquf":

Masukkan rule tawaqquf.

---

# 10. PERATURAN PENTING TENTANG PENAMBAHAN FEATURE

AI TIDAK BOLEH:

- mengubah workflow,
- menambah fasa,
- menggabungkan fasa,
- menghapus gate,
- menukar prinsip,

tanpa persetujuan pemilik projek.

Cadangan boleh diberikan.

Pelaksanaan mesti menunggu kelulusan.

---

# 11. LARANGAN KHUSUS

Dilarang:

❌ Combined workflow sebagai workflow produksi

Contoh:

```
Parafrasa
+
Terjemahan
+
Back Translation
```

dalam satu prompt.

Ia hanya dibenarkan untuk:

- ujian,
- benchmark,
- eksperimen.

---

❌ Menganggap output AI pertama sebagai gaya rasmi.

---

❌ Mengubah "saya" menjadi "the author" tanpa keputusan editorial.

---

❌ Menggunakan memory yang belum diluluskan.

---

# 12. UKURAN KEJAYAAN

Sistem dianggap berjaya apabila:

1. Buku lengkap diterjemah dari awal hingga akhir.
2. Kesalahan makna minimum.
3. Suara pengarang dikekalkan.
4. Istilah penting konsisten.
5. Semakan manusia berkurang kerana sistem menyediakan konteks yang tepat.
6. Buku boleh diterjemahkan ke bahasa lain dengan menggunakan Book Profile + Decision Memory.

---

# 13. SOALAN WAJIB SEBELUM SETIAP PERUBAHAN BESAR

Sebelum AI mencadangkan perubahan:

Tanya:

1. Adakah ini meningkatkan fidelity?
2. Adakah ini mengurangkan beban editor?
3. Adakah ini mengekalkan kawalan manusia?
4. Adakah ia bercanggah dengan workflow locked?

Jika jawapan tidak jelas:

JANGAN IMPLEMENT.

---

# STATUS AKHIR

Workflow terkunci:

```
BOOK SCAN
      ↓
BOOK PROFILE
      ↓
UNIT CREATION
      ↓
PARAPHRASE PHASE
      ↓
HUMAN APPROVAL
      ↓
TRANSLATION PHASE
      ↓
BACK TRANSLATION
      ↓
FINAL REVIEW
      ↓
COMPLETE TRANSLATED BOOK
```

**Sebarang cadangan yang mempercepatkan proses tetapi mengurangkan kawalan editorial mesti dianggap sebagai risiko, bukan penambahbaikan.**

---
