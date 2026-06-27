# eval/reports — архив прогонов

Каждый прогон бенчмарка можно заархивировать сюда, чтобы вернуться и исследовать:

```bash
uv run python eval/run_eval.py --corpus data/pdfs --model <id> --label "<cfg1,cfg2>" --report <label>
```

Создаёт `eval/reports/<label>/`:
- **`results.md`** — таблица метрик (precision/fpr/pos_cov/neg_spec/recall/mat/valid/fabr/tokens/cost$/$ per correct/lat) + доверительные интервалы (bootstrap 95%).
- **`dump.jsonl`** — per-row сырые сигналы (faith, gate_passed, match_min, confidence, correct, cost, id, config…) для оффлайн-анализа.
- **`meta.json`** — когда, какие фильтры/корпус, какие конфиги.

Оффлайн-анализ дампа (risk-coverage, выбор порога, дискриминация сигналов, парные дельты конфигов):

```bash
uv run python scripts/analyze_thresholds.py eval/reports/<label>/dump.jsonl
```

Сводные выводы по итогам — в `eval/FINDINGS.md` (durable; `eval/results.md` в корне перезатирается каждым прогоном).

## Колонки results.md
`prec` точность выданных · `fpr` доля уверенно-неверных · `pos_cov` покрытие отвечаемых · `neg_spec`
негативы корректно-воздержаны · `recall` doc-level (multihop требует ВСЕ документы) · `mat` покрытие
марок проката · `valid` прошли гард · `fabr` галлюцин. цитаты · `cost$` USD/ответ (по-модельно) ·
`$/corr` USD за КОРРЕКТНЫЙ ответ.
