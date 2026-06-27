| model | strategy | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4-pro | rag+gate | 0.54 | 0.22 | 0.57 | 1.00 | 0.62 | 0.26 | 0.63 | 4 | 7603 | 0.0027 | 0.0067 | 36.1 |
| deepseek-v4-pro | verify_ensemble | 0.43 | 0.15 | 0.30 | 1.00 | 0.62 | 0.17 | 0.26 | 4 | 5948 | 0.0043 | 0.0167 | 38.3 |
| deepseek-v4-pro | model_ensemble | 0.40 | 0.11 | 0.22 | 1.00 | 0.62 | 0.06 | 0.19 | 0 | 11789 | 0.0097 | 0.0435 | 61.0 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| deepseek-v4-pro | rag+gate | [0.27, 0.80] | [0.07, 0.41] |
| deepseek-v4-pro | verify_ensemble | [0.00, 0.83] | [0.04, 0.30] |
| deepseek-v4-pro | model_ensemble | [0.00, 1.00] | [0.00, 0.22] |
