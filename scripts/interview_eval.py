#!/usr/bin/env python3
"""
Next Genius interview auto-scoring worker (runs in GitHub Actions).

Flow per applicant who has submitted interview videos but has no up-to-date eval:
  yt-dlp downloads compressed audio of each YouTube (unlisted) URL
    -> Groq Whisper transcribes
    -> Groq Llama scores the transcripts against a scholarship rubric (JSON)
    -> result written to Firestore collection `interviewEvals/{uid}` (admin-only).

Secrets (env): GROQ_API_KEY, FIREBASE_SA (full service-account JSON string).
Test mode:  python interview_eval.py --test-url "<youtube url>"   (no Firestore needed)
"""
import os, sys, json, hashlib, tempfile, subprocess, time

GROQ = "https://api.groq.com/openai/v1"
WHISPER_MODEL = "whisper-large-v3-turbo"
CHAT_MODEL = "llama-3.3-70b-versatile"
MAX_AUDIO_SECONDS = 900  # trim to 15 min for scoring

RUBRIC = """You are an admissions reviewer for the Next Genius Scholarship, which funds
high-performing, middle-income Indian high-school students to attend leading global colleges.
You are given transcripts of two short interview videos: a STUDENT video and a FAMILY video.

Score each dimension from 1 (poor) to 5 (excellent) and give a one-line reason for each:
- motivation_goals: clarity and depth of the student's motivation and goals
- communication: how clearly and confidently the student expresses themselves
- academic_fit: alignment of interests/achievements with studying at a global college
- authenticity: how genuine and self-aware the student and family come across
- family_support: family's understanding of and support for studying abroad
- need_fit: consistency with a middle-income background that genuinely needs the scholarship
  (flag if the family appears affluent or the story contradicts financial need)

Then give:
- overall: one of "strong", "consider", "weak"
- summary: 3-4 sentence summary for the reviewer
- red_flags: array of short strings (empty if none) for anything concerning
  (e.g. coached/scripted answers, inconsistencies, affluence contradicting need, off-topic)

Respond with ONLY a JSON object of this exact shape:
{"scores":{"motivation_goals":{"score":int,"reason":str},"communication":{...},"academic_fit":{...},
"authenticity":{...},"family_support":{...},"need_fit":{...}},
"overall":str,"summary":str,"red_flags":[str]}"""


def log(*a):
    print(*a, flush=True)


def download_audio(url, outdir):
    """yt-dlp -> compressed mono 16k mp3 (small enough for Whisper). Returns path or None."""
    out = os.path.join(outdir, "a.%(ext)s")
    cmd = [
        "yt-dlp", "--no-playlist", "--quiet", "--no-warnings",
        "--extractor-args", "youtube:player_client=android,web",
        "-f", "bestaudio/best", "-x", "--audio-format", "mp3",
        "--postprocessor-args", f"ffmpeg:-ac 1 -ar 16000 -b:a 48k -t {MAX_AUDIO_SECONDS}",
        "-o", out, url,
    ]
    for attempt in range(3):
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
            mp3 = os.path.join(outdir, "a.mp3")
            if os.path.exists(mp3) and os.path.getsize(mp3) > 1000:
                return mp3
        except Exception as e:
            log(f"  yt-dlp attempt {attempt+1} failed: {str(e)[:200]}")
            time.sleep(5)
    return None


def transcribe(path, key):
    import requests
    with open(path, "rb") as f:
        r = requests.post(
            f"{GROQ}/audio/transcriptions",
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (os.path.basename(path), f, "audio/mpeg")},
            data={"model": WHISPER_MODEL, "response_format": "json", "language": "en"},
            timeout=180,
        )
    r.raise_for_status()
    return (r.json().get("text") or "").strip()


def score(student_tx, family_tx, key):
    import requests
    user = f"STUDENT VIDEO TRANSCRIPT:\n{student_tx or '(no usable transcript)'}\n\nFAMILY VIDEO TRANSCRIPT:\n{family_tx or '(no usable transcript)'}"
    r = requests.post(
        f"{GROQ}/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": CHAT_MODEL,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": RUBRIC},
                {"role": "user", "content": user},
            ],
        },
        timeout=120,
    )
    r.raise_for_status()
    return json.loads(r.json()["choices"][0]["message"]["content"])


def evaluate_urls(student_url, family_url, key):
    """Returns (result_dict, status, reason). status in {ok, partial, failed}."""
    with tempfile.TemporaryDirectory() as d:
        s_tx = f_tx = ""
        s_ok = f_ok = False
        if student_url:
            p = download_audio(student_url, os.path.join(d, "s") if False else d)
            if p:
                s_tx = transcribe(p, key); s_ok = bool(s_tx)
                os.remove(p)
        if family_url:
            p = download_audio(family_url, d)
            if p:
                f_tx = transcribe(p, key); f_ok = bool(f_tx)
        if not (s_ok or f_ok):
            return None, "failed", "could not download/transcribe either video (YouTube may have blocked the download)"
        result = score(s_tx, f_tx, key)
        result["transcripts"] = {"student": s_tx[:6000], "family": f_tx[:6000]}
        result["videoUrls"] = {"student": student_url, "family": family_url}
        result["models"] = {"transcribe": WHISPER_MODEL, "score": CHAT_MODEL}
        status = "ok" if (s_ok and f_ok) else "partial"
        return result, status, ("one video could not be transcribed" if status == "partial" else "")


def src_hash(s, f):
    return hashlib.sha256(f"{s}|{f}".encode()).hexdigest()[:16]


def run_firestore(key):
    import firebase_admin
    from firebase_admin import credentials, firestore
    sa = json.loads(os.environ["FIREBASE_SA"])
    firebase_admin.initialize_app(credentials.Certificate(sa))
    db = firestore.client()

    done = 0
    for doc in db.collection("applicants").where("onboarding.interview", "==", True).stream():
        a = doc.to_dict()
        uid = doc.id
        iv = (a.get("interview") or {})
        su, fu = iv.get("studentVideo"), iv.get("familyVideo")
        if not (su or fu):
            continue
        h = src_hash(su, fu)
        ev_ref = db.collection("interviewEvals").document(uid)
        ev = ev_ref.get()
        if ev.exists and ev.to_dict().get("sourceHash") == h and ev.to_dict().get("status") in ("ok", "partial"):
            continue  # already evaluated for these exact URLs
        name = (a.get("firstName") or "") + " " + (a.get("lastName") or "")
        log(f"Evaluating {uid} ({name.strip()}) ...")
        try:
            result, status, reason = evaluate_urls(su, fu, key)
        except Exception as e:
            result, status, reason = None, "failed", str(e)[:300]
        payload = {
            "uid": uid, "sourceHash": h, "status": status, "reason": reason,
            "evaluatedAt": firestore.SERVER_TIMESTAMP,
        }
        if result:
            payload.update(result)
        ev_ref.set(payload)
        log(f"  -> {status} {('('+reason+')') if reason else ''}")
        done += 1
    log(f"Done. Processed {done} applicant(s).")


def main():
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        log("ERROR: GROQ_API_KEY not set"); sys.exit(1)
    if len(sys.argv) >= 3 and sys.argv[1] == "--test-url":
        url = sys.argv[2]
        log(f"TEST MODE: scoring single URL as student video: {url}")
        result, status, reason = evaluate_urls(url, None, key)
        log("STATUS:", status, reason)
        log(json.dumps(result, indent=2)[:2500] if result else "(no result)")
        return
    run_firestore(key)


if __name__ == "__main__":
    main()
