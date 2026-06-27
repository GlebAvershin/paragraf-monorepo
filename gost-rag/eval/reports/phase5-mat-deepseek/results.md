| model | strategy | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v3 | rag+hybrid+gate+div.k16 | 0.94 | 0.04 | 0.74 | 1.00 | 0.91 | 0.32 | 0.78 | 2 | 12757 | 0.0021 | 0.0028 | 36.4 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| deepseek-v3 | rag+hybrid+gate+div.k16 | [0.81, 1.00] | [0.00, 0.11] |
