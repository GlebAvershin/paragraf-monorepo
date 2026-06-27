| model | strategy | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| glm-5.2 | rag+hybrid+gate+div.k16 | 0.83 | 0.11 | 0.78 | 1.00 | 0.91 | 0.32 | 0.81 | 1 | 13098 | 0.0085 | 0.0120 | 37.8 |
| minimax-m3 | rag+hybrid+gate+div.k16 | 0.86 | 0.07 | 0.61 | 1.00 | 0.91 | 0.45 | 0.67 | 9 | 14761 | 0.0044 | 0.0074 | 53.0 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| glm-5.2 | rag+hybrid+gate+div.k16 | [0.67, 1.00] | [0.00, 0.22] |
| minimax-m3 | rag+hybrid+gate+div.k16 | [0.67, 1.00] | [0.00, 0.19] |
