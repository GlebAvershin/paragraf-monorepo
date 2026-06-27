| model | strategy | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3-8b | rag+raw | 0.35 | 0.56 | 1.00 | 1.00 | 0.62 | 0.22 | 0.70 | 1 | 7709 | 0.0010 | 0.0023 | 36.5 |
| qwen3-8b | rag+gate | 0.54 | 0.22 | 0.57 | 1.00 | 0.64 | 0.17 | 0.63 | 3 | 7805 | 0.0011 | 0.0026 | 36.2 |
| qwen3-8b | rag+hybrid+gate | 0.50 | 0.22 | 0.52 | 1.00 | 0.69 | 0.25 | 0.67 | 1 | 7106 | 0.0010 | 0.0027 | 38.3 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| qwen3-8b | rag+raw | [0.17, 0.56] | [0.37, 0.74] |
| qwen3-8b | rag+gate | [0.27, 0.82] | [0.07, 0.37] |
| qwen3-8b | rag+hybrid+gate | [0.22, 0.78] | [0.07, 0.37] |
