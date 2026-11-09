CREATE TABLE game_match (
  id UUID PRIMARY KEY,
  host_player_id UUID NOT NULL REFERENCES player(id),
  started_at TIMESTAMPTZ(3) NOT NULL,
  finished_at TIMESTAMPTZ(3) NOT NULL,
  CHECK (started_at < finished_at)
);
CREATE TABLE match_participant (
  match_id UUID NOT NULL REFERENCES game_match(id),
  player_id UUID NOT NULL REFERENCES player(id),
  finished_at TIMESTAMPTZ(3) NOT NULL,
  final_score_units BIGINT NOT NULL CHECK (final_score_units >= 0),
  final_rank INTEGER NOT NULL CHECK (final_rank >= 1),
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX match_participant_history ON match_participant(player_id, finished_at DESC, match_id DESC);
CREATE TABLE match_question_snapshot (
  match_id UUID NOT NULL REFERENCES game_match(id),
  question_position INTEGER NOT NULL CHECK (question_position BETWEEN 1 AND 10),
  question_text TEXT NOT NULL,
  correct_choice_key TEXT NOT NULL,
  PRIMARY KEY (match_id, question_position)
);
CREATE TABLE match_question_choice_snapshot (
  match_id UUID NOT NULL,
  question_position INTEGER NOT NULL,
  choice_key TEXT NOT NULL,
  display_order INTEGER NOT NULL CHECK (display_order >= 1),
  choice_text TEXT NOT NULL,
  PRIMARY KEY (match_id, question_position, choice_key),
  UNIQUE (match_id, question_position, display_order),
  FOREIGN KEY (match_id, question_position) REFERENCES match_question_snapshot(match_id, question_position)
);
ALTER TABLE match_question_snapshot ADD CONSTRAINT match_question_correct_choice
  FOREIGN KEY (match_id, question_position, correct_choice_key)
  REFERENCES match_question_choice_snapshot(match_id, question_position, choice_key)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE match_answer_snapshot (
  match_id UUID NOT NULL,
  question_position INTEGER NOT NULL,
  player_id UUID NOT NULL,
  selected_choice_key TEXT,
  attempt_count INTEGER NOT NULL,
  final_answered_ms INTEGER,
  question_score_units BIGINT NOT NULL CHECK (question_score_units >= 0),
  PRIMARY KEY (match_id, question_position, player_id),
  FOREIGN KEY (match_id, player_id) REFERENCES match_participant(match_id, player_id),
  FOREIGN KEY (match_id, question_position) REFERENCES match_question_snapshot(match_id, question_position),
  FOREIGN KEY (match_id, question_position, selected_choice_key)
    REFERENCES match_question_choice_snapshot(match_id, question_position, choice_key),
  CHECK (
    (selected_choice_key IS NULL AND attempt_count = 0 AND final_answered_ms IS NULL AND question_score_units = 0)
    OR (selected_choice_key IS NOT NULL AND attempt_count BETWEEN 1 AND 3
      AND final_answered_ms IS NOT NULL AND final_answered_ms >= 0 AND final_answered_ms < 10000)
  )
);
