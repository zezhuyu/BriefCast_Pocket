#!/bin/bash

pip install -r requirements.txt

pyinstaller --onefile --add-data "db/resources:db/resources" --add-data "db/schema.ddl:db" --add-data "db/rss.csv:db" --add-data ".env:." --collect-data language_tags --collect-data espeakng_loader --collect-data pymilvus --collect-data milvus_lite --collect-data apify_fingerprint_datapoints --collect-data kokoro --collect-data spacy --collect-data en_core_web_sm --collect-data misaki --icon=app.ico --name "api" api.py

