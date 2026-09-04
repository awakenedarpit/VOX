from pathlib import Path
import subprocess


def test_frontend_javascript_parses():
    js = Path(__file__).parents[1] / 'frontend' / 'script.js'
    result = subprocess.run(['node', '--check', str(js)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
