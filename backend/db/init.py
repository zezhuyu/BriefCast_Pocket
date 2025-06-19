from dotenv import load_dotenv
import sqlite3
import os
import sys
from pymilvus import MilvusClient, DataType
from tinydb import TinyDB, Query
import csv
import shutil
load_dotenv()

DIMENSION = int(os.getenv('VECTOR_DIM', 1024))

current_file_dir = os.path.join(os.path.expanduser("~"), "BriefCast_data")
static_dir = os.path.dirname(os.path.abspath(__file__))

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE_DIR = os.path.join(current_file_dir, "data")

DB_DIR = os.path.join(current_file_dir, "dbs")
CONTENT_DIR = os.path.join(current_file_dir, "data", "content")
SCRIPT_DIR = os.path.join(current_file_dir, "data", "script")
TRANSCRIPT_DIR = os.path.join(current_file_dir, "data", "transcript")
IMAGE_DIR = os.path.join(current_file_dir, "data", "image")
AUDIO_DIR = os.path.join(current_file_dir, "data", "audio")

resources_dir = os.path.join(static_dir, "resources")

if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)

if not os.path.exists(CONTENT_DIR):
    os.makedirs(CONTENT_DIR)

if not os.path.exists(SCRIPT_DIR):
    os.makedirs(SCRIPT_DIR)

if not os.path.exists(TRANSCRIPT_DIR):
    os.makedirs(TRANSCRIPT_DIR)

if not os.path.exists(IMAGE_DIR):
    os.makedirs(IMAGE_DIR)

if not os.path.exists(AUDIO_DIR):
    os.makedirs(AUDIO_DIR)

for filename in os.listdir(resources_dir):
    filepath = os.path.join(resources_dir, filename)
    if os.path.isfile(filepath):
        name, ext = os.path.splitext(filename)
        if ext == ".png":
            if not os.path.exists(os.path.join(IMAGE_DIR, filename)):
                shutil.copy(filepath, os.path.join(IMAGE_DIR, filename))
        elif ext == ".wav":
            if not os.path.exists(os.path.join(AUDIO_DIR, filename)):
                shutil.copy(filepath, os.path.join(AUDIO_DIR, filename))
        elif ext == ".lrc":
            if not os.path.exists(os.path.join(TRANSCRIPT_DIR, filename)):
                shutil.copy(filepath, os.path.join(TRANSCRIPT_DIR, filename))

sql_file = os.path.join(static_dir, "schema.ddl")

if not os.path.exists(os.path.join(DB_DIR, 'user.json')):
    user_db = TinyDB(os.path.join(DB_DIR, 'user.json'))

rss_csv_file = os.path.join(static_dir, "rss.csv")

schema = MilvusClient.create_schema()

index_params = MilvusClient.prepare_index_params()

schema.add_field(field_name="id", datatype=DataType.VARCHAR, is_primary=True, max_length=1000, enable_analyzer=True, enable_match=True)
schema.add_field(field_name="published_at", datatype=DataType.FLOAT)
schema.add_field(field_name="sparse", datatype=DataType.SPARSE_FLOAT_VECTOR)
schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR, dim=DIMENSION)

index_params.add_index(
    field_name="sparse",
    index_type="SPARSE_INVERTED_INDEX",
    metric_type="IP",
    params={"inverted_index_algo": "TAAT_NAIVE"},
)

index_params.add_index(
    field_name="vector",
    index_type="IVF_FLAT",
    metric_type="COSINE",
    params={
        "nlist": 128
    }
)

def load_links_to_mongodb(csv_file_path):
    links = rss_db.table('links')
    with open(csv_file_path, 'r') as file:
        reader = csv.reader(file)
        for row in reader:
            links.insert({
                'country': row[0],
                'category': row[1],
                'link': row[2],
                "lastEtag": None,
                "lastModified": None,
                "updatedParsed": None,
                "lastCheck": None,
                "available": True,
            })

if not os.path.exists(os.path.join(DB_DIR, 'sql.db')):
    sqlite_client = sqlite3.connect(os.path.join(DB_DIR, 'sql.db'))
    with open(sql_file, 'r', encoding='utf-8') as f:
        sqlite_client.executescript(f.read())
    sqlite_client.commit()
    sqlite_client.close()

if not os.path.exists(os.path.join(DB_DIR, 'milvus.db')):
    milvus_client = MilvusClient(os.path.join(DB_DIR, 'milvus.db'))
    milvus_client.create_collection(collection_name="briefcast", schema=schema, index_params=index_params)

if not os.path.exists(os.path.join(DB_DIR, 'rss.json')):
    rss_db = TinyDB(os.path.join(DB_DIR, 'rss.json'))
    load_links_to_mongodb(rss_csv_file)