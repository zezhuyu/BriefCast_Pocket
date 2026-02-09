"""
Shared MCP handler functions for both stdio and HTTP servers.
"""
import json
import sys
import traceback
from typing import Optional, List, Dict, Any

# Add parent directory to path
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ---- helpers ----
def _parse_bool(value: Any, default: bool = False) -> bool:
    """Parse bool-ish values coming from tool arguments."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "1", "yes", "y", "on"):
            return True
        if v in ("false", "0", "no", "n", "off"):
            return False
    return default

# Import news service functions with error handling
try:
    from services.news_service import (
        search_news,
        get_todays_news,
        get_financial_news,
        get_company_news
    )
except ImportError as e:
    print(f"Warning: Failed to import news service: {e}", file=sys.stderr)
    search_news = None
    get_todays_news = None
    get_financial_news = None
    get_company_news = None

# User preferences cache (in production, this should be stored in database)
_user_preferences: Dict[str, Dict[str, str]] = {}

def get_user_preferences(user_id: str) -> Dict[str, str]:
    """Get user preferences from cache or database."""
    return _user_preferences.get(user_id, {"country": None, "language": "en"})

def set_user_preferences(user_id: str, country: Optional[str] = None, language: str = "en"):
    """Set user preferences."""
    _user_preferences[user_id] = {
        "country": country,
        "language": language
    }

# MCP Tool Definitions
MCP_TOOLS = [
    {
        "name": "search_news",
        "description": "Search for news articles using a query string. Returns a list of news items matching the query.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query string"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 20)",
                    "default": 20
                },
                "country": {
                    "type": "string",
                    "description": "Country code (US, CA, GB, etc.) or null for global",
                    "enum": ["US", "CA", "GB", "CN", "FR", None]
                },
                "language": {
                    "type": "string",
                    "description": "Language code (en, zh, fr, etc.)",
                    "default": "en"
                },
                "extract_content": {
                    "type": "boolean",
                    "description": "If true, also fetch full article text (slower).",
                    "default": False
                },
                "user_id": {
                    "type": "string",
                    "description": "User ID for preference lookup"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "get_todays_news",
        "description": "Get today's top news articles. Can filter by sector or return overall top news.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sector": {
                    "type": "string",
                    "description": "News sector: business, finance, tech, science, health, sports, entertainment, politics, general (optional)",
                    "enum": ["business", "finance", "tech", "science", "health", "sports", "entertainment", "politics", "general", None]
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 20)",
                    "default": 20
                },
                "country": {
                    "type": "string",
                    "description": "Country code (US, CA, GB, etc.) or null for global",
                    "enum": ["US", "CA", "GB", "CN", "FR", None]
                },
                "language": {
                    "type": "string",
                    "description": "Language code (en, zh, fr, etc.)",
                    "default": "en"
                },
                "extract_content": {
                    "type": "boolean",
                    "description": "If true, also fetch full article text (slower).",
                    "default": False
                },
                "user_id": {
                    "type": "string",
                    "description": "User ID for preference lookup"
                }
            }
        }
    },
    {
        "name": "get_financial_news",
        "description": "Get financial and macroeconomic news articles.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 20)",
                    "default": 20
                },
                "country": {
                    "type": "string",
                    "description": "Country code (US, CA, GB, etc.) or null for global",
                    "enum": ["US", "CA", "GB", "CN", "FR", None]
                },
                "language": {
                    "type": "string",
                    "description": "Language code (en, zh, fr, etc.)",
                    "default": "en"
                },
                "extract_content": {
                    "type": "boolean",
                    "description": "If true, also fetch full article text (slower).",
                    "default": False
                },
                "user_id": {
                    "type": "string",
                    "description": "User ID for preference lookup"
                }
            }
        }
    },
    {
        "name": "get_company_news",
        "description": "Get news articles about a specific company, including stock, earnings, and general news.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "company": {
                    "type": "string",
                    "description": "Company name"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 20)",
                    "default": 20
                },
                "country": {
                    "type": "string",
                    "description": "Country code (US, CA, GB, etc.) or null for global",
                    "enum": ["US", "CA", "GB", "CN", "FR", None]
                },
                "language": {
                    "type": "string",
                    "description": "Language code (en, zh, fr, etc.)",
                    "default": "en"
                },
                "extract_content": {
                    "type": "boolean",
                    "description": "If true, also fetch full article text (slower).",
                    "default": False
                },
                "user_id": {
                    "type": "string",
                    "description": "User ID for preference lookup"
                }
            },
            "required": ["company"]
        }
    },
    {
        "name": "set_user_preferences",
        "description": "Set user preferences for country and language.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_id": {
                    "type": "string",
                    "description": "User ID"
                },
                "country": {
                    "type": "string",
                    "description": "Country code (US, CA, GB, etc.) or null for global",
                    "enum": ["US", "CA", "GB", "CN", "FR", None]
                },
                "language": {
                    "type": "string",
                    "description": "Language code (en, zh, fr, etc.)",
                    "default": "en"
                }
            },
            "required": ["user_id"]
        }
    }
]

def handle_mcp_request(method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle MCP request and return response.
    
    Args:
        method: MCP method name
        params: Method parameters
    
    Returns:
        Response dictionary
    """
    try:
        if method == "initialize":
            # MCP protocol initialization
            return {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "briefcast-news",
                    "version": "1.0.0"
                }
            }
        
        elif method == "tools/list":
            return {
                "tools": MCP_TOOLS
            }
        
        elif method == "tools/call":
            tool_name = params.get("name")
            arguments = params.get("arguments", {})
            
            # Get user preferences if user_id is provided
            user_id = arguments.get("user_id")
            if user_id:
                prefs = get_user_preferences(user_id)
                if not arguments.get("country"):
                    arguments["country"] = prefs.get("country")
                if not arguments.get("language"):
                    arguments["language"] = prefs.get("language", "en")

            # Content extraction flag (support both extract_content and extract alias)
            extract_content = _parse_bool(
                arguments.get("extract_content", arguments.get("extract")),
                default=False
            )
            
            try:
                if tool_name == "search_news":
                    if search_news is None:
                        return {
                            "error": {
                                "code": -32603,
                                "message": "News service not available. Please check dependencies."
                            }
                        }
                    result = search_news(
                        query=arguments["query"],
                        country=arguments.get("country"),
                        language=arguments.get("language", "en"),
                        limit=arguments.get("limit", 20),
                        extract_content=extract_content
                    )
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result, indent=2)
                            }
                        ]
                    }
                
                elif tool_name == "get_todays_news":
                    if get_todays_news is None:
                        return {
                            "error": {
                                "code": -32603,
                                "message": "News service not available. Please check dependencies."
                            }
                        }
                    result = get_todays_news(
                        country=arguments.get("country"),
                        language=arguments.get("language", "en"),
                        sector=arguments.get("sector"),
                        limit=arguments.get("limit", 20),
                        extract_content=extract_content
                    )
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result, indent=2)
                            }
                        ]
                    }
                
                elif tool_name == "get_financial_news":
                    if get_financial_news is None:
                        return {
                            "error": {
                                "code": -32603,
                                "message": "News service not available. Please check dependencies."
                            }
                        }
                    result = get_financial_news(
                        country=arguments.get("country"),
                        language=arguments.get("language", "en"),
                        limit=arguments.get("limit", 20),
                        extract_content=extract_content
                    )
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result, indent=2)
                            }
                        ]
                    }
                
                elif tool_name == "get_company_news":
                    if get_company_news is None:
                        return {
                            "error": {
                                "code": -32603,
                                "message": "News service not available. Please check dependencies."
                            }
                        }
                    result = get_company_news(
                        company_name=arguments["company"],
                        country=arguments.get("country"),
                        language=arguments.get("language", "en"),
                        limit=arguments.get("limit", 20),
                        extract_content=extract_content
                    )
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result, indent=2)
                            }
                        ]
                    }
                
                elif tool_name == "set_user_preferences":
                    set_user_preferences(
                        user_id=arguments["user_id"],
                        country=arguments.get("country"),
                        language=arguments.get("language", "en")
                    )
                    return {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps({"message": "Preferences updated"})
                            }
                        ]
                    }
                
                else:
                    return {
                        "error": {
                            "code": -32601,
                            "message": f"Method not found: {tool_name}"
                        }
                    }
            except Exception as e:
                # Log error to stderr
                print(f"Error in tool {tool_name}: {e}\n{traceback.format_exc()}", file=sys.stderr)
                # Return error in result format
                return {
                    "error": {
                        "code": -32603,
                        "message": f"Error executing {tool_name}: {str(e)}"
                    }
                }
        
        else:
            return {
                "error": {
                    "code": -32601,
                    "message": f"Method not found: {method}"
                }
            }
    
    except Exception as e:
        return {
            "error": {
                "code": -32603,
                "message": f"Internal error: {str(e)}"
            }
        }

