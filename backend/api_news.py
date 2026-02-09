"""
REST API endpoints for news retrieval.
"""
from flask import Blueprint, request, jsonify
from functools import wraps
import logging
from typing import Optional, Tuple
import jwt
import os

from services.news_service import (
    search_news,
    get_todays_news,
    get_financial_news,
    get_company_news
)
from db.db import get_user_preferences, update_user_preferences, get_user, get_user_tokens

logger = logging.getLogger(__name__)

# Create a Flask blueprint for news endpoints
news_api = Blueprint('news_api', __name__)

# Get SECRET_KEY - should match api.py
# We'll import it from api.py when available, or use the same logic
def get_secret_key():
    """Get secret key - matches api.py implementation."""
    from db.db import get_password_hash, store_password_hash
    import secrets
    import string
    
    def generate_secure_password(length=16):
        if length < 8:
            raise ValueError("Password length should be at least 8 characters")
        letters = string.ascii_letters
        digits = string.digits
        symbols = string.punctuation
        password = [
            secrets.choice(letters),
            secrets.choice(digits),
            secrets.choice(symbols)
        ]
        all_chars = letters + digits + symbols
        password += [secrets.choice(all_chars) for _ in range(length - 3)]
        secrets.SystemRandom().shuffle(password)
        return ''.join(password)
    
    secret_key = get_password_hash("admin")
    if not secret_key:
        secret_key = generate_secure_password()
        store_password_hash(secret_key)
    return secret_key

SECRET_KEY = get_secret_key()

def get_user_country_language(user_id: str) -> Tuple[Optional[str], str]:
    """Get user's country and language preferences."""
    prefs = get_user_preferences(user_id)
    country = prefs.get("country") if prefs else None
    language = prefs.get("language", "en") if prefs else "en"
    return country, language

def token_required(f):
    """Decorator to require authentication token - matches api.py implementation."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            token = request.headers['Authorization'].replace('Bearer ', '')
        if 'token' in request.cookies:
            token = request.cookies['token']

        if not token:
            return jsonify({'error': 'Token is missing'}), 401

        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            uid = payload.get("uid") or payload.get("sub")

            if not get_user(uid):
                return jsonify({'error': 'User not found'}), 401
            tokens = get_user_tokens(uid)
            if token not in [t["token"] for t in tokens]:
                return jsonify({'error': 'Token not found'}), 401
            
            request.environ['USER_ID'] = uid

        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Token has expired'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Invalid token'}), 401

        return f(*args, **kwargs)
    return decorated

@news_api.route('/api/news/search', methods=['GET'])
@token_required
def search_news_endpoint():
    """
    Search for news using a query string.
    
    Query Parameters:
        q: Search query (required)
        limit: Maximum number of results (default: 20)
        country: Override country code (optional)
        language: Override language code (optional)
        extract: If true, also fetch full article content (default: false)
    
    Returns:
        JSON array of news items (with 'content' field if extract=true)
    """
    try:
        user_id = request.environ.get("USER_ID")
        query = request.args.get('q')
        
        if not query:
            return jsonify({"error": "Query parameter 'q' is required"}), 400
        
        limit = int(request.args.get('limit', 20))
        country = request.args.get('country')
        language = request.args.get('language')
        extract = request.args.get('extract', 'false').lower() == 'true'
        
        # Use user preferences if not overridden
        if not country or not language:
            user_country, user_language = get_user_country_language(user_id)
            country = country or user_country
            language = language or user_language
        
        news_items = search_news(
            query=query,
            country=country,
            language=language,
            limit=limit,
            extract_content=extract
        )
        
        return jsonify(news_items), 200
        
    except Exception as e:
        logger.error(f"Error in search_news_endpoint: {e}")
        return jsonify({"error": str(e)}), 500

@news_api.route('/api/news/today', methods=['GET'])
@token_required
def get_todays_news_endpoint():
    """
    Get today's top news.
    
    Query Parameters:
        sector: News sector (optional) - business, finance, tech, science, health, sports, entertainment, politics, general
        limit: Maximum number of results (default: 20)
        country: Override country code (optional)
        language: Override language code (optional)
        extract: If true, also fetch full article content (default: false)
    
    Returns:
        JSON array of news items (with 'content' field if extract=true)
    """
    try:
        user_id = request.environ.get("USER_ID")
        sector = request.args.get('sector')
        limit = int(request.args.get('limit', 20))
        country = request.args.get('country')
        language = request.args.get('language')
        extract = request.args.get('extract', 'false').lower() == 'true'
        
        # Use user preferences if not overridden
        if not country or not language:
            user_country, user_language = get_user_country_language(user_id)
            country = country or user_country
            language = language or user_language
        
        news_items = get_todays_news(
            country=country,
            language=language,
            sector=sector,
            limit=limit,
            extract_content=extract
        )
        
        return jsonify(news_items), 200
        
    except Exception as e:
        logger.error(f"Error in get_todays_news_endpoint: {e}")
        return jsonify({"error": str(e)}), 500

@news_api.route('/api/news/financial', methods=['GET'])
@token_required
def get_financial_news_endpoint():
    """
    Get financial/macro economic news.
    
    Query Parameters:
        limit: Maximum number of results (default: 20)
        country: Override country code (optional)
        language: Override language code (optional)
        extract: If true, also fetch full article content (default: false)
    
    Returns:
        JSON array of financial news items (with 'content' field if extract=true)
    """
    try:
        user_id = request.environ.get("USER_ID")
        limit = int(request.args.get('limit', 20))
        country = request.args.get('country')
        language = request.args.get('language')
        extract = request.args.get('extract', 'false').lower() == 'true'
        
        # Use user preferences if not overridden
        if not country or not language:
            user_country, user_language = get_user_country_language(user_id)
            country = country or user_country
            language = language or user_language
        
        news_items = get_financial_news(
            country=country,
            language=language,
            limit=limit,
            extract_content=extract
        )
        
        return jsonify(news_items), 200
        
    except Exception as e:
        logger.error(f"Error in get_financial_news_endpoint: {e}")
        return jsonify({"error": str(e)}), 500

@news_api.route('/api/news/company', methods=['GET'])
@token_required
def get_company_news_endpoint():
    """
    Get news for a specific company.
    
    Query Parameters:
        company: Company name (required)
        limit: Maximum number of results (default: 20)
        country: Override country code (optional)
        language: Override language code (optional)
        extract: If true, also fetch full article content (default: false)
    
    Returns:
        JSON array of news items about the company (with 'content' field if extract=true)
    """
    try:
        user_id = request.environ.get("USER_ID")
        company = request.args.get('company')
        
        if not company:
            return jsonify({"error": "Query parameter 'company' is required"}), 400
        
        limit = int(request.args.get('limit', 20))
        country = request.args.get('country')
        language = request.args.get('language')
        extract = request.args.get('extract', 'false').lower() == 'true'
        
        # Use user preferences if not overridden
        if not country or not language:
            user_country, user_language = get_user_country_language(user_id)
            country = country or user_country
            language = language or user_language
        
        news_items = get_company_news(
            company_name=company,
            country=country,
            language=language,
            limit=limit,
            extract_content=extract
        )
        
        return jsonify(news_items), 200
        
    except Exception as e:
        logger.error(f"Error in get_company_news_endpoint: {e}")
        return jsonify({"error": str(e)}), 500

@news_api.route('/api/news/preferences', methods=['GET', 'POST'])
@token_required
def user_preferences_endpoint():
    """
    Get or set user preferences (country and language).
    
    GET: Returns current preferences
    POST: Updates preferences
    
    POST Body:
        {
            "country": "US" (optional),
            "language": "en" (optional)
        }
    """
    try:
        user_id = request.environ.get("USER_ID")
        
        if request.method == 'GET':
            prefs = get_user_preferences(user_id)
            return jsonify(prefs or {}), 200
        
        elif request.method == 'POST':
            data = request.get_json()
            country = data.get('country')
            language = data.get('language')
            
            update_user_preferences(user_id, country=country, language=language)
            
            return jsonify({"message": "Preferences updated"}), 200
        
    except Exception as e:
        logger.error(f"Error in user_preferences_endpoint: {e}")
        return jsonify({"error": str(e)}), 500

