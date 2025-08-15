from fastapi import FastAPI, Query
from cachetools import TTLCache
import httpx

app = FastAPI(title="AniList API")

cache = TTLCache(maxsize=100, ttl=300)

ANILIST_API_URL = "https://graphql.anilist.co"

# ---------------- GraphQL Queries ----------------
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

QUERY_SEARCH = """
query ($search: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(search: $search, type: ANIME) {
      id
      title {
        romaji
        english
      }
      status
      coverImage {
        large
      }
    }
  }
}
"""

QUERY_GET_ANIME = """
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title {
      romaji
      english
      native
    }
    type
    startDate {
      year
    }
    status
    genres
    synonyms
    description(asHtml: false)
    coverImage {
      large
    }
    episodes
  }
}
"""

# ---------------- Functions ----------------
async def fetch_recent_releases():
    if "recent_releases" in cache:
        return cache["recent_releases"]

    variables = {"page": 1, "perPage": 10}
    async with httpx.AsyncClient() as client:
        response = await client.post(ANILIST_API_URL, json={"query": QUERY_RECENT_RELEASES, "variables": variables})
        data = response.json()
    
    result = []
    for anime in data.get("data", {}).get("Page", {}).get("media", []):
        result.append({
            "episodeId": anime["id"],
            "name": anime["title"]["romaji"] or anime["title"]["english"],
            "episodeNum": anime.get("episodes"),
            "subOrDub": "Sub",
            "imgUrl": anime["coverImage"]["large"]
        })
    
    cache["recent_releases"] = result
    return result

async def fetch_search(query: str):
    cache_key = f"search_{query}"
    if cache_key in cache:
        return cache[cache_key]

    variables = {"search": query, "page": 1, "perPage": 10}
    async with httpx.AsyncClient() as client:
        response = await client.post(ANILIST_API_URL, json={"query": QUERY_SEARCH, "variables": variables})
        data = response.json()
    
    result = []
    for anime in data.get("data", {}).get("Page", {}).get("media", []):
        result.append({
            "anime_id": anime["id"],
            "name": anime["title"]["romaji"] or anime["title"]["english"],
            "img_url": anime["coverImage"]["large"],
            "status": anime["status"]
        })

    cache[cache_key] = result
    return result

async def fetch_anime_details(anime_id: int):
    cache_key = f"anime_{anime_id}"
    if cache_key in cache:
        return cache[cache_key]

    variables = {"id": anime_id}
    async with httpx.AsyncClient() as client:
        response = await client.post(ANILIST_API_URL, json={"query": QUERY_GET_ANIME, "variables": variables})
        data = response.json()

    media = data.get("data", {}).get("Media", {})
    result = {
        "name": media["title"]["romaji"] or media["title"]["english"],
        "type": media["type"],
        "released": media["startDate"]["year"],
        "status": media["status"],
        "genres": media["genres"],
        "othername": ", ".join(media.get("synonyms", [])),
        "synopsis": media["description"],
        "imageUrl": media["coverImage"]["large"],
        "totalEpisodes": media.get("episodes"),
        "episode_id": media["id"]
    }

    cache[cache_key] = result
    return result

# ---------------- Routes ----------------
@app.get("/recent-release")
async def recent_release():
    return await fetch_recent_releases()

@app.get("/search")
async def search(query: str = Query(..., description="Anime adıyla arama")):
    return await fetch_search(query)

@app.get("/getAnime")
async def get_anime(id: int = Query(..., description="Anime ID'si")):
    return await fetch_anime_details(id)
