| model | strategy | prec | fpr | pos_cov | neg_spec | recall | mat | valid | fabr | tokens | cost$ | $/corr | lat_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4-pro | rag+hybrid+gate+div.k16 | 0.77 | 0.11 | 0.57 | 1.00 | 0.91 | 0.26 | 0.67 | 3 | 14578 | 0.0048 | 0.0093 | 49.6 |

### Доверительные интервалы (bootstrap 95%)

| model | strategy | precision CI | fpr CI |
|---|---|---|---|
| deepseek-v4-pro | rag+hybrid+gate+div.k16 | [0.50, 1.00] | [0.00, 0.22] |
