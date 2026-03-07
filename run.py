"""Simple runner that starts Flask without debug reloader."""
import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import app
app.run(host="127.0.0.1", port=5001, debug=False)
