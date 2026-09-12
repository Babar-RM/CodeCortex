import os
import sys

# Ensure parser-service root directory is added to sys.path for pytest module imports
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
