#!/usr/bin/env python3
"""Download official realesr-general-x4v3 weights and export the local ONNX file.

Runtime remaster never calls this. Install requirements.txt first, then:
  pip install -r requirements-bootstrap.txt --extra-index-url https://download.pytorch.org/whl/cpu
  python scripts/bootstrap_model.py
"""

from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().with_name("export_srvgg.py")), run_name="__main__")
