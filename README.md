# LLM Key Checker

Cek validitas banyak API key sekaligus terhadap endpoint OpenAI-compatible mana pun
(Qwen/DashScope, OpenAI, OpenRouter, Groq, DeepSeek, dan lainnya). Hasilnya tampil
live di terminal dan ditulis ke file JSON.

## Cara kerja

Skrip membaca daftar akun dari file JSON, lalu mengecek tiap `api_key` ke `BASE_URL`.
Ada dua mode:

- `token` — `GET /models`. Ringan, tidak makan kuota, hanya cek apakah key terotorisasi.
- `model` — `POST /chat/completions` ke model tertentu. Cek akses ke model spesifik.

Tiap key diklasifikasikan jadi `VALID`, `RESTRICTED`, `INVALID`, `RATE_LIMITED`, atau `ERROR`.

## Prasyarat

[Bun](https://bun.sh/) versi 1.0 ke atas. Kalau belum terpasang:

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# atau via package manager
npm install -g bun        # lewat npm
brew install oven-sh/bun/bun   # macOS (Homebrew)
```

Cek instalasi:

```bash
bun --version
```

## Setup

```bash
git clone <repo-url>
cd llm-key-checker
bun install
cp .env.example .env
```

Sesuaikan `.env`, lalu siapkan file input berisi daftar akun. Defaultnya `accounts.json`:

```json
[
  {
    "email": "mail@mail.id",
    "password": "xxxx",
    "api_key": "sk-xxx",
    "timestamp": "2025-01-01 00:00:00"
  }
]
```

Hanya `api_key` yang wajib. Field lain opsional.

## Menjalankan

```bash
bun run check
```

Atau langsung tanpa script:

```bash
bun run check.ts
```

Override konfigurasi sekali jalan lewat environment variable, misalnya:

```bash
CHECK_MODE=model MODEL=qwen-plus,qwen-max CONCURRENCY=10 bun run check
```

Hasil ditulis ke `output/results-<timestamp>.json`. Kalau `SPLIT_OUTPUT=true`, file
per kategori juga dibuat di `output/<timestamp>/valid.json`, `invalid.json`, dan seterusnya.

## Konfigurasi

Semua diatur lewat `.env`:

| Variabel       | Default                                                  | Keterangan                                                              |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `BASE_URL`     | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | Base URL endpoint OpenAI-compatible.                                   |
| `CHECK_MODE`   | `token`                                                  | `token` (GET /models) atau `model` (POST /chat/completions).           |
| `MODEL`        | `qwen-plus`                                              | Model yang dicek saat mode `model`. Bisa beberapa, pisahkan koma.      |
| `INPUT_FILE`   | `results.json`                                           | File input. `.env.example` menyetelnya ke `accounts.json`.             |
| `OUTPUT_DIR`   | `output`                                                 | Folder hasil.                                                          |
| `SPLIT_OUTPUT` | `true`                                                   | Tulis file terpisah per kategori selain file gabungan.                 |
| `CONCURRENCY`  | `5`                                                      | Jumlah pengecekan paralel.                                             |
| `TIMEOUT_MS`   | `15000`                                                  | Timeout per request (ms).                                             |

## Status

| Status         | Arti                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `VALID`        | Key aktif dan terotorisasi.                                           |
| `RESTRICTED`   | Key valid tapi tidak punya akses ke model tertentu / belum eligible. |
| `INVALID`      | Tidak terotorisasi, key salah atau revoked (HTTP 401/403).           |
| `RATE_LIMITED` | Kena rate limit / kuota habis (HTTP 429). Key tetap dianggap valid.  |
| `ERROR`        | Timeout, masalah jaringan, atau HTTP tak terduga.                    |

Di mode `model` dengan beberapa model, status key diambil dari yang terbaik:
`VALID` > `RESTRICTED` > `RATE_LIMITED` > `INVALID` > `ERROR`.

## Catatan

File `.env` dan folder `output/` berisi API key penuh (tidak di-mask) serta kredensial.
Keduanya sudah masuk `.gitignore`, jangan di-commit.
