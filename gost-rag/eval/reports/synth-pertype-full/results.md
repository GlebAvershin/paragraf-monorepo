| model | strategy | n | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v3 | rag+hybrid+gate+div.k16 | 49 | 0.84 | 0.14 | 0.90 | 0.00 | 0.82 | 0.72 | 0.94 | 4 | 9950 | 0.0015 | 0.0020 | 23.4 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| deepseek-v3 | rag+hybrid+gate+div.k16 | [0.73, 0.95] | [0.04, 0.24] |
