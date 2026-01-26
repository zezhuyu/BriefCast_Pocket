#!/usr/bin/env python3
"""
Generate an authentication token for testing the News API.
This script can sign up a new user or sign in with an existing user.
"""
import requests
import json
import sys
import os

BASE_URL = "http://localhost:5002"

def signup_user(user_id: str, password: str) -> str:
    """Sign up a new user and return the token."""
    print(f"Signing up new user: {user_id}")
    
    # Default preference structure
    preference = {
        "subtopics": {}
    }
    
    data = {
        "user_id": user_id,
        "password": password,
        "preference": preference
    }
    
    try:
        # Signup requires localhost IP
        response = requests.post(
            f"{BASE_URL}/signup",
            json=data,
            headers={"Content-Type": "application/json"},
            timeout=10
        )
        
        if response.status_code == 200:
            result = response.json()
            token = result.get("token")
            if token:
                print(f"✓ User created successfully!")
                return token
            else:
                print(f"✗ No token in response: {result}")
                return None
        else:
            print(f"✗ Signup failed: {response.status_code}")
            try:
                error = response.json()
                print(f"  Error: {error}")
            except:
                print(f"  Error: {response.text}")
            return None
    
    except requests.exceptions.ConnectionError:
        print(f"✗ Cannot connect to server at {BASE_URL}")
        print("  Make sure the server is running: python api.py")
        return None
    except Exception as e:
        print(f"✗ Error: {e}")
        return None

def signin_user(user_id: str, password: str) -> str:
    """Sign in with existing user and return the token."""
    print(f"Signing in user: {user_id}")
    
    data = {
        "user_id": user_id,
        "password": password
    }
    
    try:
        response = requests.post(
            f"{BASE_URL}/signin",
            json=data,
            headers={"Content-Type": "application/json"},
            timeout=10
        )
        
        if response.status_code == 200:
            result = response.json()
            token = result.get("token")
            if token:
                print(f"✓ Sign in successful!")
                return token
            else:
                print(f"✗ No token in response: {result}")
                return None
        else:
            print(f"✗ Sign in failed: {response.status_code}")
            try:
                error = response.json()
                print(f"  Error: {error}")
            except:
                print(f"  Error: {response.text}")
            return None
    
    except requests.exceptions.ConnectionError:
        print(f"✗ Cannot connect to server at {BASE_URL}")
        print("  Make sure the server is running: python api.py")
        return None
    except Exception as e:
        print(f"✗ Error: {e}")
        return None

def main():
    """Main function to generate token."""
    print("=" * 60)
    print("Token Generator for News API")
    print("=" * 60)
    print()
    
    # Check if server is running
    try:
        response = requests.get(f"{BASE_URL}/signup", timeout=2)
    except requests.exceptions.ConnectionError:
        print("✗ Server is not running!")
        print("\nPlease start the server first:")
        print("  cd backend")
        print("  python api.py")
        sys.exit(1)
    except:
        pass  # Server might be running, continue
    
    # Default test user credentials
    default_user_id = "test_user"
    default_password = "test_password_123"
    
    # Check command line arguments
    if len(sys.argv) >= 3:
        user_id = sys.argv[1]
        password = sys.argv[2]
        action = sys.argv[3] if len(sys.argv) > 3 else "signup"
    else:
        print("Usage options:")
        print("  1. Sign up new user: python generate_token.py <user_id> <password> signup")
        print("  2. Sign in existing: python generate_token.py <user_id> <password> signin")
        print("  3. Use defaults:     python generate_token.py")
        print()
        
        use_defaults = input(f"Use default test user ({default_user_id})? [Y/n]: ").strip().lower()
        if use_defaults in ['', 'y', 'yes']:
            user_id = default_user_id
            password = default_password
            action = "signup"
        else:
            user_id = input("Enter user_id: ").strip()
            password = input("Enter password: ").strip()
            action = input("Action (signup/signin) [signup]: ").strip().lower() or "signup"
    
    print()
    
    # Try to sign in first (in case user exists), then signup if that fails
    if action == "signin":
        token = signin_user(user_id, password)
    else:
        # Try signup first
        token = signup_user(user_id, password)
        
        # If signup fails (user might exist), try signin
        if not token:
            print("\nUser might already exist. Trying to sign in...")
            token = signin_user(user_id, password)
    
    if token:
        print()
        print("=" * 60)
        print("✓ TOKEN GENERATED SUCCESSFULLY")
        print("=" * 60)
        print()
        print("Your authentication token:")
        print("-" * 60)
        print(token)
        print("-" * 60)
        print()
        print("You can now use this token to test the News API:")
        print()
        print(f"  python test_requests.py {token}")
        print()
        print("Or use it in curl commands:")
        print(f'  curl -H "Authorization: Bearer {token}" ...')
        print()
        
        # Save token to file
        token_file = "test_token.txt"
        try:
            with open(token_file, "w") as f:
                f.write(token)
            print(f"✓ Token saved to {token_file}")
        except:
            pass
        
        return token
    else:
        print()
        print("=" * 60)
        print("✗ FAILED TO GENERATE TOKEN")
        print("=" * 60)
        print()
        print("Please check:")
        print("  1. Server is running (python api.py)")
        print("  2. User credentials are correct")
        print("  3. Server logs for errors")
        sys.exit(1)

if __name__ == "__main__":
    main()

