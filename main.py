from fastapi import FastAPI
from cachetools import TTLCache
import httpx

app = FastAPI(title="AniList Recent Release API")

# Cache: max 100 öğe, 300 saniye (5 dk) TTL
cache = TTLCache(maxsize=100, ttl=300)

ANILIST_API_URL = "https://graphql.anilist.co"

# AniList GraphQL sorgusu: Son çıkan bölümleri çekmek için
QUERY_RECENT_RELEASES = """
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(sort: UPDATED_AT_DESC, type: ANIME) {
      id
      title {
        romaji
        english
      }
      episodes
      coverImage {
        large
      }
    }
  }
}
"""

async def fetch_recent_releases():
    if "recent_releases" in cache:
        return cache["recent_releases"]

    variables = {"page": 1, "perPage": 10}  # Son 10 anime
    async with httpx.AsyncClient() as client:
        response = await client.post(
            ANILIST_API_URL,
            json={"query": QUERY_RECENT_RELEASES, "variables": variables}
        )
        data = response.json()
    
    result = []
    for anime in data.get("data", {}).get("Page", {}).get("media", []):
        result.append({
            "episodeId": anime["id"],
            "name": anime["title"]["romaji"] or anime["title"]["english"],
            "episodeNum": anime.get("episodes"),
            "subOrDub": "Sub",  # AniList API sub/dub bilgisini vermiyor, default Sub
            "imgUrl": anime["coverImage"]["large"]
        })
    
    cache["recent_releases"] = result
    return result

@app.get("/recent-release")
async def recent_release():
    return await fetch_recent_releases()
