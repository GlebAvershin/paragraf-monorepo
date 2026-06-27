| model | strategy | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v3 | rag+gate | 0.55 | 0.33 | 0.87 | 1.00 | 0.62 | 0.17 | 0.89 | 2 | 6315 | 0.0012 | 0.0022 | 18.7 |
| deepseek-v3 | rag+gate+div.k16 | 0.68 | 0.22 | 0.83 | 1.00 | 0.84 | 0.22 | 0.85 | 3 | 10599 | 0.0017 | 0.0028 | 31.5 |
| deepseek-v3 | rag+hybrid+gate+div.k16 | 0.90 | 0.07 | 0.91 | 1.00 | 0.91 | 0.22 | 0.93 | 1 | 12307 | 0.0019 | 0.0023 | 31.8 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| deepseek-v3 | rag+gate | [0.33, 0.75] | [0.19, 0.52] |
| deepseek-v3 | rag+gate+div.k16 | [0.47, 0.88] | [0.07, 0.37] |
| deepseek-v3 | rag+hybrid+gate+div.k16 | [0.77, 1.00] | [0.00, 0.19] |
