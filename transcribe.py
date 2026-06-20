import sys
import os
import json

# Add current directory to PATH so whisper can find ffmpeg.exe
current_dir = os.path.dirname(os.path.abspath(__file__))
os.environ["PATH"] += os.pathsep + current_dir

import whisper

def transcribe(file_path):
    try:
        # Load model (base is a good balance between speed and accuracy)
        model = whisper.load_model("base")
        result = model.transcribe(file_path)
        return {"text": result["text"]}
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)
    
    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        sys.exit(1)
        
    result = transcribe(file_path)
    print(json.dumps(result))
