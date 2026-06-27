| model | strategy | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v3 | rag+hybrid+gate+div.k16 | 0.79 | 0.15 | 0.83 | 1.00 | 0.91 | 0.28 | 0.85 | 5 | 12513 | 0.0020 | 0.0028 | 35.4 |
| gigachat-max | rag+hybrid+gate+div.k16 | 0.89 | 0.09 | 0.82 | 0.00 | 0.89 | 0.20 | 0.82 | 2 | 12399 | 0.1085 | 0.1492 | 33.6 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| deepseek-v3 | rag+hybrid+gate+div.k16 | [0.61, 0.95] | [0.04, 0.30] |
| gigachat-max | rag+hybrid+gate+div.k16 | [0.67, 1.00] | [0.00, 0.27] |
