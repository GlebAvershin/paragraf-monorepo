#!/usr/bin/env bash
# Download the real ГОСТ/СП/ТР ТС/СанПиН corpus referenced by the labeled gold set (data.md).
# One file per document (deduped by designation). Idempotent: skips files already present & non-empty.
# Usage: bash scripts/fetch_corpus.sh [out_dir]
set -u
OUT="${1:-data/pdfs}"
mkdir -p "$OUT"

# slug | url   (slug becomes <slug>.pdf; designation is re-detected from the PDF text at ingest)
read -r -d '' MANIFEST <<'EOF'
gost-34028-2016|https://apex-metal.ru/gost/armatura/gost_34028-16.pdf
sp-63.13330.2018|https://ano-alpha.ru/upload/iblock/58c/mjvjzkirysdmzq31jd53bipez0mxsqd5/SP_63.13330.2018_-2.pdf
gost-r-53772-2010|https://krepcom.ru/upload/iblock/df9/n2d7m61h69hyuexwyseqydsm47uu0eex/GOST_R_53772-2010.pdf
gost-r-57997-2017|https://armicon.ru/gost/files/ГОСТ%20Р%2057997%202017%20Закладные%20и%20соединения%20сварные.pdf
gost-14098-2014|https://armicon.ru/gost/files/ГОСТ%2014098-2014%20Соединения%20сварные.pdf
sp-27.13330.2017|https://nav.tn.ru/cloud/iblock/153/15338325b66de13ddb61c81797ecdb8d/SP-27.13330.2017-Betonnye-i-zhelezobetonnye-konstruktsii_-prednaznachennye-dlya-raboty-v-usloviyakh....pdf
gost-r-70520-2022|https://files.stroyinf.ru/Data/792/79282.pdf
gost-31938-2022|https://mzpkk.ru/wa-data/public/site/data/mzpkk.ru/documents/ГОСТ%2031938-2022.pdf
sp-295.1325800.2017|https://files.stroyinf.ru/Data2/1/4293743/4293743312.pdf
sp-28.13330.2017|https://nav.tn.ru/cloud/iblock/b8a/b8ad8139b843ec16bbd54997b4c482c6/SP-28.13330.2017-Zashchita-stroitelnykh-konstruktsiy-ot-korrozii-_s-Izmeneniyami-_-1_4_.pdf
gost-15150-69|https://www.mkt-asdm.ru/upload/medialibrary/gost-i-tu/15150-69.pdf
gost-33260-2015|https://armatura-truboprovodnaya.ru/files/-----33260--2015------------------------.--------,--------------.pdf
gost-12.2.063-2015|https://novocherkassk.23met.ru/gost_files/gost-12.2.063-2015.pdf
tr-ts-012-2011|https://sptg.ru/upload/iblock/2d4/5htgvcf0dqnadf40uhrwl0pp4kz13rf5.pdf
gost-r-55508-2013|https://www.reglament.by/wp-content/uploads/docs/tr/032/GOST-R-55508-2013.pdf
gost-15543.1-89|https://www.asepro.ru/docs/gost_15543.1-89.pdf
gost-33257-2015|https://armatura-truboprovodnaya.ru/files/-----33257-2015------------------------.----------------------------.pdf
gost-r-55018-2012|https://www.reglament.by/wp-content/uploads/docs/tr/032/GOST-R-55018-2012.pdf
gost-19681-2016|https://www.abok.ru/for_spec/norm_doc/norm/gost19681.pdf
sp-30.13330.2020|https://www.flamax.ru/upload/iblock/76a/wupbogja1g15e7j0nf09iqzcwikhy080/sp_30.13330.2020_vnutrennij_vodoprovod_i_kanalizaciya_zdanij_snip_2.04.01_85.pdf
gost-34771-2021|https://lepton.ru/GOST/Data/758/75871.pdf
gost-25809-2019|https://i-tech-rf.ru/upload/iblock/5c4/0lvw47so8r9pb3bgb3r4t9o2emqocfic/GOST-25809_2019-SMESITELI-I-KRANY-VODORAZBORNYE.pdf
sanpin-1.2.3685-21|https://nagut6.gosuslugi.ru/netcat_files/174/2801/SP123685_21.pdf
sp-2.4.3648-20|https://lyceum.urfu.ru/fileadmin/user_upload/docs/SP_2.4.3648-20.pdf
EOF

dl() {
  local slug="$1" url="$2" dst="$OUT/$1.pdf"
  if [ -s "$dst" ]; then echo "skip  $slug (exists)"; return; fi
  if curl -fsSL --max-time 150 --retry 2 --retry-delay 2 \
        -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
        -o "$dst" "$url"; then
    echo "ok    $slug ($(wc -c <"$dst" | tr -d ' ') bytes)"
  else
    echo "FAIL  $slug  <- $url"; rm -f "$dst"
  fi
}

pids=()
while IFS='|' read -r slug url; do
  [ -z "$slug" ] && continue
  dl "$slug" "$url" &
  pids+=($!)
  # cap concurrency at 6
  if [ "${#pids[@]}" -ge 6 ]; then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
done <<< "$MANIFEST"
wait
echo "=== done ==="
