# Arsitektur Website Ocean Nexus untuk Identifikasi Kapal

Dokumen ini menjelaskan arsitektur website Ocean Nexus, alur data, dan bentuk variabel input/output untuk identifikasi jenis kapal/alat tangkap seperti `trawlers`, deteksi `spoofing`, deteksi `go_dark`, serta kelompok event GFW seperti `fishing`, `encounter`, dan `loitering`.

## Ringkasan Sistem

Ocean Nexus terdiri dari tiga lapisan utama:

| Lapisan | Komponen | Fungsi |
|---|---|---|
| Frontend | `index.html`, Leaflet, JavaScript browser | Menampilkan peta, marker kapal, trajectory, panel GFW, AIS, dan AI Inference |
| Serverless API | `api/gfw/*`, `api/inference/*` | Proxy dan cache ke GFW API serta proxy ke server inference |
| Inference Server | `InferenceGFW/api_server.py`, `InferenceGFW/inference_gfw.py` | Mengambil data track/event kapal, preprocessing, menjalankan model LSTM, menghasilkan prediksi |

Alur utamanya:

```text
Browser
  -> /api/gfw/events
  -> GFW API
  -> marker event GFW di peta

Browser
  -> /api/inference/batch/latest atau /api/inference/gfw/stream
  -> Hugging Face/FastAPI inference server
  -> model LSTM gear, spoofing, godark
  -> marker AI + label + alert di peta
```

## Mode Data di Website

| Mode | Sumber data | Output utama |
|---|---|---|
| GFW Events | Global Fishing Watch `/v3/events` | Event `fishing`, `encounter`, `loitering` di wilayah Indonesia |
| AIS Live | AISStream WebSocket | Posisi kapal real-time, speed, course, heading, trail |
| AI Inference | FastAPI inference server | Prediksi gear, spoofing, go-dark per kapal |

## Input GFW Events

Endpoint internal:

```http
GET /api/gfw/events?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
```

Jika parameter tidak dikirim, server memakai rentang default 3 bulan terakhir atau 90 hari terakhir. Request yang mencoba mundur lebih jauh dari 90 hari akan dibatasi oleh backend ke window maksimum tersebut.

Variabel input ke GFW API:

| Variabel | Tipe | Contoh | Keterangan |
|---|---:|---|---|
| `start_date` | string date | `2026-05-16` | Tanggal awal pencarian event |
| `end_date` | string date | `2026-06-16` | Tanggal akhir pencarian event |
| `datasets` | string[] | `public-global-fishing-events:latest` | Dataset GFW yang diminta |
| `geometry` | GeoJSON Polygon | bbox Indonesia | Area pencarian: 95E-141E, 11S-6N |
| `limit` | number | `200` | Batas event yang diambil |
| `sort` | string | `-start` | Urutan event terbaru lebih dulu |

Dataset GFW yang dipakai:

| Dataset | Kelompok event |
|---|---|
| `public-global-fishing-events:latest` | `fishing` |
| `public-global-encounters-events:latest` | `encounter` |
| `public-global-loitering-events:latest` | `loitering` |

## Output GFW Events

Response internal:

```json
{
  "events": [
    {
      "id": "event-id",
      "type": "fishing",
      "position": {
        "lat": -5.123,
        "lon": 120.456
      },
      "vessel": {
        "id": "gfw-vessel-id",
        "ssvid": "525123456",
        "name": "VESSEL NAME",
        "flag": "IDN"
      },
      "start": "2026-06-01T00:00:00Z",
      "end": "2026-06-01T03:00:00Z"
    }
  ],
  "fetched_at": "2026-06-16T00:00:00.000Z"
}
```

Normalisasi di frontend menjadi:

| Variabel | Tipe | Keterangan |
|---|---:|---|
| `source` | string | Selalu `gfw` |
| `key` | string | Key unik marker |
| `id` | string | ID event GFW |
| `type` | string | `FISHING`, `ENCOUNTER`, `LOITERING`, atau lainnya |
| `lat` | number | Latitude marker |
| `lon` | number | Longitude marker |
| `mmsi` | string/null | MMSI dari `vessel.ssvid` |
| `name` | string | Nama kapal, fallback `Unknown` |
| `flag` | string/null | Negara bendera |
| `vesselId` | string/null | ID kapal GFW |
| `start` | string datetime | Waktu mulai event |
| `end` | string datetime | Waktu selesai event |
| `durationHours` | number/null | Durasi event dalam jam |

## Input AIS Live

AIS live memakai WebSocket AISStream:

```text
wss://stream.aisstream.io/v0/stream
```

Payload subscription:

```json
{
  "APIKey": "aisstream-api-key",
  "BoundingBoxes": [
    [[-11.0, 95.0], [6.0, 141.0]]
  ],
  "FilterMessageTypes": ["PositionReport", "ShipStaticData"]
}
```

Variabel AIS yang dipakai:

| Variabel | Tipe | Keterangan |
|---|---:|---|
| `mmsi` | string | Identitas kapal |
| `name` | string/null | Nama kapal dari static data |
| `lat` | number | Latitude |
| `lon` | number | Longitude |
| `speed` | number | Speed over ground dalam knot |
| `course` | number | Course over ground derajat |
| `heading` | number | Heading derajat |
| `timestamp` | number/string | Waktu pesan |

## Input AI Inference

AI inference dapat berjalan dari dua jalur:

| Jalur | Endpoint frontend | Fungsi |
|---|---|---|
| Batch latest | `/api/inference/batch/latest` | Ambil hasil inference backend terakhir, paling ringan untuk user |
| Streaming | `/api/inference/gfw/stream` | Jalankan/fetch inference per kapal dan kirim hasil via SSE |

Proxy frontend meneruskan request ke inference server:

```text
INFERENCE_URL=https://ngenss12-inferencegfw.hf.space
```

Endpoint streaming:

```http
GET /api/inference/gfw/stream?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&max_vessels=0&task=all
```

Variabel query:

| Variabel | Tipe | Default | Keterangan |
|---|---:|---|---|
| `start_date` | string date | 90 hari lalu | Tanggal awal data GFW |
| `end_date` | string date | hari ini | Tanggal akhir data GFW |
| `max_vessels` | number | `0` | `0` berarti semua vessel yang ditemukan, batas server maksimum 200 |
| `task` | enum | `all` | `all`, `gear`, `spoofing`, atau `godark` |

## Input Baris AIS/GFW untuk Model

Model menerima data per titik per kapal. Minimal:

| Variabel | Tipe | Wajib | Keterangan |
|---|---:|---:|---|
| `mmsi` | string | Ya | Identitas kapal untuk grouping sequence |
| `timestamp` | integer | Ya | Unix timestamp detik |
| `lat` | number | Ya | Latitude |
| `lon` | number | Ya | Longitude |
| `speed` | number | Tidak | Knot, fallback `0.0` |
| `course` | number | Tidak | Derajat, fallback `0.0` |
| `distance_from_shore` | number | Tidak | Jarak dari pantai, fallback `-1.0` |
| `distance_from_port` | number | Tidak | Jarak dari port, fallback `-1.0` |
| `vessel_id` | string | Tidak | ID kapal GFW, dipakai untuk referensi ulang |

Endpoint CSV/JSON inference juga mendefinisikan schema ini di `AisRow`:

```json
{
  "mmsi": "525123456",
  "timestamp": 1781181535,
  "lat": -5.123,
  "lon": 120.456,
  "speed": 6.4,
  "course": 182.0,
  "distance_from_shore": -1.0,
  "distance_from_port": -1.0
}
```

## Feature Engineering Model

Data mentah diproses menjadi 25 fitur numerik per timestep:

| Fitur | Keterangan |
|---|---|
| `speed` | Kecepatan AIS/GFW |
| `vx`, `vy` | Komponen vektor kecepatan berdasarkan speed dan course |
| `dspeed` | Perubahan speed antar titik |
| `accel` | Akselerasi per menit |
| `dcourse` | Perubahan course antar titik |
| `turn_rate` | Laju belok per menit |
| `abs_dcourse` | Nilai absolut perubahan course |
| `step_km` | Jarak antar titik, dibatasi 25 km |
| `step_km_raw` | Jarak antar titik mentah, dibatasi 500 km |
| `dt` | Delta waktu antar titik dalam detik |
| `dt_log` | `log1p(dt)` |
| `implied_speed_knots_raw` | Kecepatan implisit dari jarak posisi |
| `distance_from_shore` | Jarak dari pantai |
| `distance_from_port` | Jarak dari pelabuhan |
| `pos_speed_knots` | Kecepatan dari perubahan posisi |
| `dpos_speed` | Perubahan `pos_speed_knots` |
| `pos_bearing_sin`, `pos_bearing_cos` | Bearing posisi dalam bentuk sin/cos |
| `bearing_error` | Selisih course AIS dan bearing posisi |
| `curvature` | Perubahan arah relatif terhadap jarak |
| `pos_speed_ma5` | Rata-rata bergerak 5 titik untuk position speed |
| `pos_speed_std5` | Standar deviasi bergerak 5 titik untuk position speed |
| `abs_turn_ma5` | Rata-rata bergerak absolut turn rate |
| `curvature_ma5` | Rata-rata bergerak curvature |

Parameter sequence:

| Parameter | Nilai | Keterangan |
|---|---:|---|
| `SEQ_LEN` | 120 | Panjang sequence model |
| `STRIDE` | 6 | Sliding window antar sequence |
| `MIN_POINTS` | 80 default, 20 untuk GFW stream | Minimum titik agar kapal bisa diinfer |
| `GAP_SECONDS` | 10800 default, 30 hari untuk GFW stream | Gap pemisah segment |
| `MAX_SPEED_KNOTS` | 50 | Filter speed input |
| `MAX_IMPLIED_KNOTS` | 42 | Filter GPS jump/posisi tidak wajar |

## Arsitektur Model AI

Model yang digunakan adalah LSTM classifier per task:

```text
Input sequence: (batch, 120, 25)
  -> Linear projection + GELU + Dropout
  -> BiLSTM
  -> pooling: last hidden + mean + max + attention
  -> concat pooled features
  -> embedding layer
  -> cosine classifier
  -> logits per kelas
  -> softmax probability
```

Task model:

| Task | Tujuan | Contoh label output |
|---|---|---|
| `gear` | Identifikasi jenis alat tangkap/kelompok kapal fishing | `trawlers`, `drifting_longlines`, `set_longlines`, `set_gillnets`, `trollers`, `purse_seines`, `pots_and_traps`, `squid_jig`, `other_fishing`, `fishing` |
| `spoofing` | Deteksi manipulasi/indikasi posisi AIS tidak wajar | label mengandung `spoof` berarti alert |
| `godark` | Deteksi kapal mematikan AIS/go-dark | label mengandung `dark` berarti alert |

## Output AI Inference

Response batch/stream digabung di frontend menjadi bentuk:

```json
{
  "status": "done",
  "elapsed_s": 123.45,
  "n_vessels": 2,
  "start_date": "2026-05-16",
  "end_date": "2026-06-16",
  "source": "gfw_events",
  "vessels": [
    {
      "mmsi": "525123456",
      "vessel_id": "gfw-vessel-id",
      "last_lat": -5.123,
      "last_lon": 120.456,
      "tasks": {
        "gear": {
          "pred_label": "trawlers",
          "confidence": 0.91,
          "margin": 0.34,
          "n_sequences": 12,
          "probs": {
            "trawlers": 0.91,
            "set_gillnets": 0.04,
            "drifting_longlines": 0.03
          }
        },
        "spoofing": {
          "pred_label": "not_spoofing",
          "confidence": 0.88,
          "margin": 0.22,
          "n_sequences": 12,
          "probs": {
            "not_spoofing": 0.88,
            "spoofing": 0.12
          }
        },
        "godark": {
          "pred_label": "go_dark",
          "confidence": 0.79,
          "margin": 0.18,
          "n_sequences": 12,
          "probs": {
            "go_dark": 0.79,
            "not_dark": 0.21
          }
        }
      }
    }
  ],
  "raw_track": [
    {
      "mmsi": "525123456",
      "timestamp": 1781181535,
      "lat": -5.123,
      "lon": 120.456,
      "speed": 6.4,
      "course": 182.0,
      "distance_from_shore": -1.0,
      "distance_from_port": -1.0
    }
  ]
}
```

Field output per task:

| Variabel | Tipe | Keterangan |
|---|---:|---|
| `pred_label` | string | Label prediksi utama |
| `confidence` | number | Probabilitas/agregasi confidence 0-1 |
| `margin` | number | Selisih dua probabilitas/logit teratas; makin besar makin yakin |
| `n_sequences` | number | Jumlah sequence yang dibentuk untuk kapal |
| `probs` | object | Probabilitas per label kelas |

Field output per vessel:

| Variabel | Tipe | Keterangan |
|---|---:|---|
| `mmsi` | string | Identitas kapal |
| `vessel_id` | string/null | ID kapal GFW |
| `last_lat` | number/null | Posisi terakhir |
| `last_lon` | number/null | Posisi terakhir |
| `tasks.gear` | object/null | Hasil identifikasi gear |
| `tasks.spoofing` | object/null | Hasil deteksi spoofing |
| `tasks.godark` | object/null | Hasil deteksi go-dark |

## Logika Identifikasi Trawler

Kapal dianggap masuk kelompok trawler ketika:

```text
tasks.gear.pred_label == "trawlers"
```

Representasi frontend:

| Elemen | Nilai |
|---|---|
| Label pendek | `Trawler` |
| Warna marker | `#e3901a` |
| Tooltip | `MMSI`, label gear, confidence persen |
| Popup | Gear, spoofing, go-dark, posisi terakhir |

Contoh output trawler:

```json
{
  "mmsi": "525123456",
  "tasks": {
    "gear": {
      "pred_label": "trawlers",
      "confidence": 0.91,
      "margin": 0.34,
      "n_sequences": 12
    }
  }
}
```

## Logika Deteksi Spoofing

Frontend menandai alert spoofing jika:

```text
tasks.spoofing.pred_label.toLowerCase().includes("spoof")
```

Artinya label seperti `spoofing` akan dianggap alert, sedangkan `not_spoofing` seharusnya dibaca hati-hati karena string tersebut tetap mengandung kata `spoof`. Jika label model memakai `not_spoofing`, logika frontend saat ini perlu diperketat menjadi exact match atau daftar label negatif agar tidak false alert.

Rekomendasi logika aman:

```js
const spoofAlert = ["spoofing", "spoof"].includes(label.toLowerCase());
```

Output alert:

| Elemen | Nilai |
|---|---|
| Warna | Merah `#f85149` |
| Marker | Ring merah |
| Tooltip | `Spoofing` |
| Panel | `Spoofing terdeteksi` |

## Logika Deteksi Go Dark

Frontend menandai alert go-dark jika:

```text
tasks.godark.pred_label.toLowerCase().includes("dark")
```

Sama seperti spoofing, jika label negatif adalah `not_dark`, logika ini dapat menghasilkan false alert karena `not_dark` mengandung kata `dark`. Rekomendasi:

```js
const darkAlert = ["go_dark", "dark"].includes(label.toLowerCase());
```

Output alert:

| Elemen | Nilai |
|---|---|
| Warna | Oranye `#e3901a` untuk teks, ring alert merah bersama spoofing |
| Tooltip | `Go Dark` |
| Panel | `Go Dark terdeteksi` |

## Kelompok Output Visual

Gear color mapping di frontend:

| Label gear | Label tampilan | Warna |
|---|---|---|
| `drifting_longlines` | Drift Longline | `#4493f8` |
| `set_longlines` | Set Longline | `#d29922` |
| `set_gillnets` | Gillnet | `#a371f7` |
| `trawlers` | Trawler | `#e3901a` |
| `trollers` | Troller | `#3fb950` |
| `purse_seines` | Purse Seine | `#39c5cf` |
| `pots_and_traps` | Pots & Traps | `#f85149` |
| `squid_jig` | Squid Jig | `#f7c948` |
| `other_fishing` | Other Fishing | `#8b949e` |
| `fishing` | Fishing | `#3fb950` |

GFW event color mapping:

| Event | Makna | Warna |
|---|---|---|
| `FISHING` | Aktivitas fishing | Hijau |
| `ENCOUNTER` | Encounter antar kapal | Oranye |
| `LOITERING` | Loitering/menunggu | Kuning |
| Lainnya | Event lain | Abu-abu |

AIS speed color mapping:

| Kondisi | Rule | Warna |
|---|---|---|
| Berhenti | `< 1 kn` | Merah |
| Lambat | `1-5 kn` | Oranye |
| Normal | `5-12 kn` | Biru |
| Cepat | `> 12 kn` | Hijau |

## Trajectory Output

Trajectory inference memakai `raw_track` yang dikembalikan server:

| Variabel | Tipe | Keterangan |
|---|---:|---|
| `mmsi` | string | Kapal pemilik titik |
| `timestamp` | number/string | Waktu titik |
| `lat` | number | Latitude |
| `lon` | number | Longitude |
| `speed` | number/null | Speed di titik |
| `course` | number/null | Course di titik |

Frontend membuat:

```text
raw_track by MMSI
  -> sort by timestamp
  -> L.polyline(lat, lon)
  -> marker Start warna hijau
  -> marker End warna merah
```

## Cache dan Refresh Data

| Data | Cache | TTL |
|---|---|---|
| GFW events server | Redis/KV atau memory fallback | Fresh 10 menit, stale 6 jam |
| GFW events browser | `localStorage` | 10 menit |
| Inference latest serverless proxy | Redis/KV | 30 detik |
| Inference browser | `localStorage` | Tidak ada TTL eksplisit, dipakai sebagai tampilan awal |

Vercel Hobby hanya mendukung cron harian. Konfigurasi saat ini:

```json
{
  "crons": [
    {
      "path": "/api/gfw/events-prewarm",
      "schedule": "0 0 * * *"
    }
  ]
}
```

## File Kunci

| File | Peran |
|---|---|
| `index.html` | UI utama, peta Leaflet, rendering GFW/AIS/AI, trajectory |
| `api/gfw/events.js` | Fetch dan cache GFW events |
| `api/gfw/events-prewarm.js` | Endpoint prewarm cache GFW untuk cron |
| `api/gfw/track.js` | Ambil trajectory kapal GFW |
| `api/gfw/vessels/search.js` | Pencarian identitas kapal GFW |
| `api/inference/health.js` | Proxy health check inference server |
| `api/inference/batch/latest.js` | Proxy hasil batch inference terbaru |
| `api/inference/gfw/stream.js` | Proxy SSE inference per kapal |
| `InferenceGFW/api_server.py` | FastAPI inference server |
| `InferenceGFW/inference_gfw.py` | Feature engineering, sequence builder, model LSTM, inference |
| `InferenceGFW/Samudera/newcodinggfw.h5` atau `Inference/newcodinggfw.h5` | Model, scaler, label map |

## Catatan Risiko Teknis

1. Logika alert spoofing/go-dark berbasis `includes()` berpotensi salah jika label negatif mengandung kata yang sama, misalnya `not_spoofing` atau `not_dark`.
2. GFW public token sering hanya memberi event positions, bukan raw track penuh, sehingga trajectory inference dapat berupa sparse track dari event.
3. Jika `raw_track` kurang dari minimum titik, model tidak akan membentuk sequence untuk kapal tersebut.
4. Karena Vercel serverless tidak selalu hidup, prewarm tidak boleh diasumsikan nonstop. Gunakan cron harian Vercel Hobby atau layanan cron eksternal bila butuh refresh lebih sering.
