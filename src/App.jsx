import { useEffect, useMemo, useState } from "react";
import {
  auth,
  db,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  writeBatch,
  onSnapshot,
  collection,
  getDocs,
  serverTimestamp,
} from "./firebase";
import { QUESTIONS } from "./questions";

const GAME_ID = "main";

const emptyAnswers = QUESTIONS.reduce((acc, q) => {
  acc[q.id] = "";
  return acc;
}, {});

function calculateScore(playerAnswers, officialAnswers) {
  return QUESTIONS.reduce((score, question) => {
    if (!officialAnswers?.[question.id]) return score;
    return playerAnswers?.[question.id] === officialAnswers[question.id]
      ? score + 1
      : score;
  }, 0);
}

export default function App() {
  const [user, setUser] = useState(null);
  const [game, setGame] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [playerName, setPlayerName] = useState("");
  const [answers, setAnswers] = useState(emptyAnswers);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adminMode, setAdminMode] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [message, setMessage] = useState("");

  const gameRef = useMemo(() => doc(db, "games", GAME_ID), []);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);

      if (!currentUser) {
        setLoading(false);
        return;
      }

      const adminDoc = await getDoc(doc(db, "admins", currentUser.uid));
      setIsAdmin(adminDoc.exists());

      const predictionRef = doc(
        db,
        "games",
        GAME_ID,
        "predictions",
        currentUser.uid
      );

      const predictionSnap = await getDoc(predictionRef);

      if (predictionSnap.exists()) {
        const data = predictionSnap.data();
        setPlayerName(data.playerName || "");
        setAnswers({ ...emptyAnswers, ...(data.answers || {}) });
        setHasSubmitted(true);
      }

      setLoading(false);
    });

    return () => unsubAuth();
  }, []);

  useEffect(() => {
    const unsubGame = onSnapshot(gameRef, (snap) => {
      if (snap.exists()) {
        setGame(snap.data());
      } else {
        setGame({
          locked: false,
          reveal: false,
          officialAnswers: {},
        });
      }
    });

    return () => unsubGame();
  }, [gameRef]);

  useEffect(() => {
    const shouldLoadLeaderboard = game?.reveal || isAdmin;
    if (!shouldLoadLeaderboard) {
      setLeaderboard([]);
      return;
    }

    loadLeaderboard();
  }, [game?.reveal, game?.officialAnswers, isAdmin]);

  async function ensureGuestLogin() {
    setMessage("");

    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
  }

  async function handleGuestStart(e) {
    e.preventDefault();

    if (!playerName.trim()) {
      setMessage("Please enter your name first.");
      return;
    }

    await ensureGuestLogin();
    setMessage("");
  }

  async function submitPrediction(e) {
    e.preventDefault();
    setMessage("");

    if (!user) {
      setMessage("Please enter your name first.");
      return;
    }

    if (game?.locked) {
      setMessage("Submissions are locked.");
      return;
    }

    if (!playerName.trim()) {
      setMessage("Please enter your name.");
      return;
    }

    const unanswered = QUESTIONS.filter((q) => !answers[q.id]);
    if (unanswered.length > 0) {
      setMessage("Please answer every question before submitting.");
      return;
    }

    await setDoc(
      doc(db, "games", GAME_ID, "predictions", user.uid),
      {
        playerName: playerName.trim(),
        answers,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );

    setHasSubmitted(true);
    setMessage("Your bets have been submitted!");
  }

  async function handleAdminLogin(e) {
    e.preventDefault();
    setMessage("");

    try {
      await signInWithEmailAndPassword(auth, adminEmail, adminPassword);
      setAdminMode(false);
      setMessage("Admin login successful.");
    } catch (err) {
      setMessage("Admin login failed. Check your email and password.");
      console.error(err);
    }
  }

  async function handleLogout() {
    await signOut(auth);
    setUser(null);
    setIsAdmin(false);
    setHasSubmitted(false);
    setAnswers(emptyAnswers);
    setPlayerName("");
    setLeaderboard([]);
    setMessage("");
  }

  async function initializeGame() {
    await setDoc(
      gameRef,
      {
        locked: false,
        reveal: false,
        officialAnswers: {},
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    setMessage("Game initialized.");
  }

  async function updateGameField(field, value) {
    await setDoc(
      gameRef,
      {
        [field]: value,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  async function updateOfficialAnswer(questionId, value) {
    await setDoc(
      gameRef,
      {
        officialAnswers: {
          ...(game?.officialAnswers || {}),
          [questionId]: value,
        },
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    setMessage("Answer saved.");
  }

  async function loadLeaderboard() {
    const predictionsSnap = await getDocs(
      collection(db, "games", GAME_ID, "predictions")
    );

    const rows = predictionsSnap.docs.map((predictionDoc) => {
      const data = predictionDoc.data();
      const score = calculateScore(data.answers, game?.officialAnswers || {});

      return {
        id: predictionDoc.id,
        playerName: data.playerName || "Unnamed guest",
        answers: data.answers || {},
        score,
      };
    });

    rows.sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName));
    setLeaderboard(rows);
  }

  async function resetGame() {
  const confirmed = window.confirm(
    "This will delete all guest submissions and clear official answers. Are you sure?"
  );

  if (!confirmed) return;

  setMessage("");

  try {
    const predictionsRef = collection(db, "games", GAME_ID, "predictions");
    const predictionsSnap = await getDocs(predictionsRef);

    const batch = writeBatch(db);

    predictionsSnap.docs.forEach((predictionDoc) => {
      batch.delete(predictionDoc.ref);
    });

    batch.set(
      gameRef,
      {
        locked: false,
        reveal: false,
        officialAnswers: {},
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();

    setLeaderboard([]);
    setMessage("Game reset complete. Guest submissions and official answers were cleared.");
  } catch (err) {
    console.error(err);
    setMessage("Reset failed. Check the console for details.");
  }
}

  if (loading) {
    return (
      <main className="page">
        <section className="card">
          <h1>Wedding Bets</h1>
          <p>Loading...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Wedding Night Game</p>
        <h1>Wedding Bets</h1>
        <p>
          Predict what will happen during the night. Once the answers are
          revealed, the leaderboard will show who knows the couple best.
        </p>
      </section>

      {message && <div className="notice">{message}</div>}

      <section className="topActions">
        {user ? (
          <button className="secondaryButton" onClick={handleLogout}>
            Log out
          </button>
        ) : (
          <button
            className="secondaryButton"
            onClick={() => setAdminMode(!adminMode)}
          >
            {adminMode ? "Back to guest mode" : "Admin login"}
          </button>
        )}
      </section>

      {adminMode && !user && (
        <section className="card">
          <h2>Admin login</h2>
          <form onSubmit={handleAdminLogin} className="form">
            <label>
              Email
              <input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="Admin password"
              />
            </label>

            <button type="submit">Log in as admin</button>
          </form>
        </section>
      )}

      {isAdmin && (
        <AdminPanel
  game={game}
  initializeGame={initializeGame}
  updateGameField={updateGameField}
  updateOfficialAnswer={updateOfficialAnswer}
  resetGame={resetGame}
  leaderboard={leaderboard}
  loadLeaderboard={loadLeaderboard}
/>
      )}

      {!isAdmin && !adminMode && (
        <>
          {!user && (
            <section className="card">
              <h2>Enter your name</h2>
              <form onSubmit={handleGuestStart} className="form">
                <label>
                  Your name
                  <input
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    placeholder="e.g. Nick"
                  />
                </label>

                <button type="submit">Start betting</button>
              </form>
            </section>
          )}

          {user && (
            <section className="card">
              <div className="cardHeader">
                <div>
                  <h2>Your bets</h2>
                  <p>
                    Playing as <strong>{playerName}</strong>
                  </p>
                </div>

                {game?.locked && <span className="pill danger">Locked</span>}
                {!game?.locked && <span className="pill">Open</span>}
              </div>

              <PredictionForm
                answers={answers}
                setAnswers={setAnswers}
                onSubmit={submitPrediction}
                disabled={game?.locked}
                hasSubmitted={hasSubmitted}
              />
            </section>
          )}

          {game?.reveal && (
            <Leaderboard
              leaderboard={leaderboard}
              officialAnswers={game?.officialAnswers || {}}
            />
          )}

          {!game?.reveal && user && hasSubmitted && (
            <section className="card mutedCard">
              <h2>Leaderboard hidden</h2>
              <p>
                Your answers are saved. The leaderboard will appear when the
                admin reveals the results.
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function PredictionForm({
  answers,
  setAnswers,
  onSubmit,
  disabled,
  hasSubmitted,
}) {
  return (
    <form onSubmit={onSubmit} className="questions">
      {QUESTIONS.map((question, index) => (
        <fieldset key={question.id} disabled={disabled} className="question">
          <legend>
            <span>{index + 1}</span>
            {question.text}
          </legend>

          <div className="options">
            {question.options.map((option) => (
              <label
                key={option}
                className={
                  answers[question.id] === option
                    ? "option selected"
                    : "option"
                }
              >
                <input
                  type="radio"
                  name={question.id}
                  value={option}
                  checked={answers[question.id] === option}
                  onChange={() =>
                    setAnswers((prev) => ({
                      ...prev,
                      [question.id]: option,
                    }))
                  }
                />
                {option}
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <button type="submit" disabled={disabled}>
        {hasSubmitted ? "Update my bets" : "Submit my bets"}
      </button>
    </form>
  );
}

function AdminPanel({
  game,
  initializeGame,
  updateGameField,
  updateOfficialAnswer,
  resetGame,
  leaderboard,
  loadLeaderboard,
}) {
  return (
    <section className="card adminCard">
      <div className="cardHeader">
        <div>
          <h2>Admin panel</h2>
          <p>Lock bets, enter the real answers, and reveal the leaderboard.</p>
        </div>
      </div>

      <div className="adminActions">
  <button onClick={initializeGame}>Initialize game</button>

  <button
    className={game?.locked ? "dangerButton" : ""}
    onClick={() => updateGameField("locked", !game?.locked)}
  >
    {game?.locked ? "Unlock submissions" : "Lock submissions"}
  </button>

  <button onClick={() => updateGameField("reveal", !game?.reveal)}>
    {game?.reveal ? "Hide leaderboard" : "Reveal leaderboard"}
  </button>

  <button className="secondaryButton" onClick={loadLeaderboard}>
    Refresh leaderboard
  </button>

  <button className="dangerButton" onClick={resetGame}>
    Reset trial run
  </button>
</div>

      <h3>Official answers</h3>

      <div className="questions">
        {QUESTIONS.map((question, index) => (
          <fieldset key={question.id} className="question">
            <legend>
              <span>{index + 1}</span>
              {question.text}
            </legend>

            <div className="options">
              {question.options.map((option) => (
                <label
                  key={option}
                  className={
                    game?.officialAnswers?.[question.id] === option
                      ? "option selected"
                      : "option"
                  }
                >
                  <input
                    type="radio"
                    name={`official-${question.id}`}
                    value={option}
                    checked={game?.officialAnswers?.[question.id] === option}
                    onChange={() => updateOfficialAnswer(question.id, option)}
                  />
                  {option}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <Leaderboard
        leaderboard={leaderboard}
        officialAnswers={game?.officialAnswers || {}}
        adminView
      />
    </section>
  );
}

function Leaderboard({ leaderboard, officialAnswers, adminView = false }) {
  return (
    <section className="card leaderboardCard">
      <h2>{adminView ? "Admin leaderboard preview" : "Leaderboard"}</h2>

      {leaderboard.length === 0 ? (
        <p>No submissions yet.</p>
      ) : (
        <div className="leaderboard">
          {leaderboard.map((row, index) => (
            <div key={row.id} className="leaderboardRow">
              <div className="rank">#{index + 1}</div>
              <div className="leaderboardName">{row.playerName}</div>
              <div className="score">
                {row.score}/{QUESTIONS.length}
              </div>
            </div>
          ))}
        </div>
      )}

      <details className="answersSummary">
        <summary>Official answers</summary>
        {QUESTIONS.map((q) => (
          <p key={q.id}>
            <strong>{q.text}</strong>
            <br />
            {officialAnswers[q.id] || "Not answered yet"}
          </p>
        ))}
      </details>
    </section>
  );
}