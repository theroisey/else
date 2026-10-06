//! Lifecycle races and historical links that generic CRUD would lose.
use crate::{clients, planning, reminders, tasks, testing::Fixture, validation};
use rusqlite::params;
use serde_json::{Value, json};

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    validation::json(&serde_json::to_vec(&v).unwrap()).unwrap()
}
fn plan_profile(scope: &planning::Scope, v: Value, updating: bool) -> planning::Profile {
    planning::Profile::parse(&serde_json::to_vec(&v).unwrap(), scope, updating).unwrap()
}

#[tokio::test]
async fn independent_task_write_capabilities_never_grant_read_or_foreign_client_access() {
    let f = Fixture::new().await;
    let user = validation::new_id();
    let role = validation::new_id();
    let now = validation::now();
    let actor = crate::security::Actor::operator(user.clone()).unwrap();
    let client = f.client.clone();
    f.db.write(move |tx| {
        tx.execute("INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?1,'writer@example.com','Synthetic task writer','unused','active',?2,?2)",params![user,now])?;
        tx.execute("INSERT INTO roles(id,role_key,display_name,created_at,updated_at) VALUES(?1,'task_write_test','Synthetic independent writes',?2,?2)",params![role,now])?;
        for permission in ["tasks.create","tasks.update","tasks.delete"] {
            tx.execute("INSERT INTO role_permissions(id,role_id,permission_key,assigned_at) VALUES(?1,?2,?3,?4)",params![validation::new_id(),role,permission,now])?;
        }
        tx.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES(?1,?2,?3,'client',?4,?5)",params![validation::new_id(),user,role,client,now])?;
        Ok(())
    }).await.unwrap();
    let task = tasks::create(
        &f.db,
        actor.clone(),
        f.client.clone(),
        input(json!({"title":"Synthetic private write"})),
    )
    .await
    .unwrap();
    assert!(
        tasks::read(&f.db, actor.clone(), f.client.clone(), task.id.clone())
            .await
            .is_err()
    );
    assert!(
        tasks::list(
            &f.db,
            actor.clone(),
            f.client.clone(),
            crate::query::Query::default()
        )
        .await
        .is_err()
    );
    assert!(
        tasks::create(
            &f.db,
            actor.clone(),
            validation::new_id(),
            input(json!({"title":"Foreign write"}))
        )
        .await
        .is_err()
    );
    tasks::update(
        &f.db,
        actor.clone(),
        f.client.clone(),
        task.id.clone(),
        input(json!({"title":"Synthetic changed write","expected_revision":1})),
    )
    .await
    .unwrap();
    tasks::archive(
        &f.db,
        actor,
        f.client.clone(),
        task.id.clone(),
        input(json!({"confirm":true,"expected_revision":2})),
    )
    .await
    .unwrap();
    assert_eq!(
        f.connection()
            .query_row(
                "SELECT count(*) FROM audit_events WHERE resource_id=?1",
                [task.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        3
    );
}

#[tokio::test]
async fn plan_windows_and_terminal_parents_are_checked_inside_concurrent_writes() {
    let f = Fixture::new().await;
    let scope = planning::Scope {
        client: f.client.clone(),
        plan: None,
    };
    let p = planning::create(&f.db, f.actor.clone(), scope.clone(), plan_profile(&scope,
        json!({"title":"Synthetic window","start_at":"2026-10-01T00:00:00Z","due_at":"2026-10-30T00:00:00Z"}), false)).await.unwrap();
    let child = planning::Scope {
        client: f.client.clone(),
        plan: Some(p.id.clone()),
    };
    let m = planning::create(
        &f.db,
        f.actor.clone(),
        child.clone(),
        plan_profile(
            &child,
            json!({"title":"Synthetic milestone","due_at":"2026-10-05T00:00:00Z"}),
            false,
        ),
    )
    .await
    .unwrap();
    let (parent, milestone) = tokio::join!(
        planning::update(
            &f.db,
            f.actor.clone(),
            scope.clone(),
            p.id.clone(),
            plan_profile(
                &scope,
                json!({"title":"Synthetic narrowed window","start_at":"2026-10-01T00:00:00Z","due_at":"2026-10-10T00:00:00Z","expected_revision":1}),
                true
            )
        ),
        planning::update(
            &f.db,
            f.actor.clone(),
            child.clone(),
            m.id.clone(),
            plan_profile(
                &child,
                json!({"title":"Synthetic moved milestone","due_at":"2026-10-15T00:00:00Z","expected_revision":1}),
                true
            )
        )
    );
    assert_ne!(parent.is_ok(), milestone.is_ok());
    assert_eq!(
        parent
            .as_ref()
            .err()
            .or(milestone.as_ref().err())
            .unwrap()
            .code(),
        "invalid_dates"
    );
    let state = planning::read(&f.db, f.actor.clone(), scope.clone(), p.id.clone())
        .await
        .unwrap();
    let rev = state["revision"].as_i64().unwrap();
    planning::status(
        &f.db,
        f.actor.clone(),
        scope.clone(),
        p.id.clone(),
        input(json!({"status":"active","expected_revision":rev})),
    )
    .await
    .unwrap();
    planning::status(
        &f.db,
        f.actor.clone(),
        scope.clone(),
        p.id.clone(),
        input(json!({"status":"completed","expected_revision":rev+1})),
    )
    .await
    .unwrap();
    assert_eq!(
        planning::create(
            &f.db,
            f.actor.clone(),
            child.clone(),
            plan_profile(&child, json!({"title":"Blocked child"}), false)
        )
        .await
        .err()
        .unwrap()
        .code(),
        "conflict"
    );
    assert!(
        planning::read(&f.db, f.actor.clone(), child.clone(), m.id.clone())
            .await
            .is_ok()
    );
    planning::status(
        &f.db,
        f.actor.clone(),
        scope.clone(),
        p.id.clone(),
        input(json!({"status":"active","expected_revision":rev+2})),
    )
    .await
    .unwrap();
    planning::archive(
        &f.db,
        f.actor.clone(),
        scope,
        p.id.clone(),
        input(json!({"confirm":true,"expected_revision":rev+3})),
    )
    .await
    .unwrap();
    assert!(
        planning::archive(
            &f.db,
            f.actor.clone(),
            child.clone(),
            m.id.clone(),
            input(json!({"confirm":true,"expected_revision":if milestone.is_ok(){2}else{1}}))
        )
        .await
        .is_err()
    );
    assert!(
        planning::read(&f.db, f.actor.clone(), child, m.id)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn milestone_links_retain_unavailable_history_and_audit_failure_rolls_back_every_change() {
    let f = Fixture::new().await;
    let scope = planning::Scope {
        client: f.client.clone(),
        plan: None,
    };
    let p = planning::create(
        &f.db,
        f.actor.clone(),
        scope.clone(),
        plan_profile(&scope, json!({"title":"Synthetic plan"}), false),
    )
    .await
    .unwrap();
    let child = planning::Scope {
        client: f.client.clone(),
        plan: Some(p.id.clone()),
    };
    let m = planning::create(
        &f.db,
        f.actor.clone(),
        child.clone(),
        plan_profile(&child, json!({"title":"Synthetic milestone"}), false),
    )
    .await
    .unwrap();
    let t = tasks::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(json!({"title":"Synthetic linked task"})),
    )
    .await
    .unwrap();
    planning::replace_links(
        &f.db,
        f.actor.clone(),
        child.clone(),
        m.id.clone(),
        input(json!({"task_ids":[t.id],"expected_revision":1})),
    )
    .await
    .unwrap();
    tasks::archive(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        t.id.clone(),
        input(json!({"confirm":true,"expected_revision":1})),
    )
    .await
    .unwrap();
    f.connection().execute("UPDATE role_permissions SET revoked_at=?1 WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_key='tasks.view'",[validation::now()]).unwrap();
    planning::replace_links(
        &f.db,
        f.actor.clone(),
        child.clone(),
        m.id.clone(),
        input(json!({"task_ids":[t.id],"expected_revision":2})),
    )
    .await
    .unwrap();
    f.connection().execute_batch("CREATE TRIGGER reject_milestone_audit BEFORE INSERT ON audit_events WHEN NEW.resource_kind='milestone' BEGIN SELECT RAISE(ABORT,'synthetic mandatory audit failure'); END;").unwrap();
    assert!(
        planning::replace_links(
            &f.db,
            f.actor.clone(),
            child.clone(),
            m.id.clone(),
            input(json!({"task_ids":[],"expected_revision":3}))
        )
        .await
        .is_err()
    );
    let value = planning::read(&f.db, f.actor.clone(), child.clone(), m.id.clone())
        .await
        .unwrap();
    assert_eq!(value["revision"], 3);
    assert_eq!(value["task_ids"], json!([t.id]));
    f.connection()
        .execute_batch("DROP TRIGGER reject_milestone_audit")
        .unwrap();
    planning::replace_links(
        &f.db,
        f.actor.clone(),
        child.clone(),
        m.id.clone(),
        input(json!({"task_ids":[],"expected_revision":3})),
    )
    .await
    .unwrap();
    assert_eq!(
        planning::replace_links(
            &f.db,
            f.actor.clone(),
            child,
            m.id.clone(),
            input(json!({"task_ids":[t.id],"expected_revision":4}))
        )
        .await
        .err()
        .unwrap()
        .code(),
        "invalid_task_link"
    );
    assert_eq!(f.connection().query_row("SELECT count(*) FROM milestone_task_links WHERE milestone_id=?1 AND unlinked_at IS NOT NULL",[m.id],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[tokio::test]
async fn reminder_history_survives_owner_and_source_revocation_and_terminal_races_commit_once() {
    let f = Fixture::new().await;
    let owner = validation::new_id();
    let role = validation::new_id();
    let now = validation::now();
    let u = owner.clone();
    let r = role.clone();
    f.db.write(move |tx| {
        tx.execute("INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?1,'owner@example.com','Synthetic reminder owner','unused','active',?2,?2)",params![u,now])?;
        tx.execute("INSERT INTO roles(id,role_key,display_name,created_at,updated_at) VALUES(?1,'reminder_test','Synthetic reminder access',?2,?2)",params![r,now])?;
        tx.execute("INSERT INTO role_permissions(id,role_id,permission_key,assigned_at) VALUES(?1,?2,'reminders.view',?3)",params![validation::new_id(),r,now])?;
        tx.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,assigned_at) VALUES(?1,?2,?3,'global',?4)",params![validation::new_id(),u,r,now])?;
        Ok(())
    }).await.unwrap();
    let task = tasks::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(json!({"title":"Synthetic source"})),
    )
    .await
    .unwrap();
    let mut v = json!({"title":"Synthetic occurrence","owner_id":owner,"scheduled_local":"2026-11-01T01:30:00.123456","timezone":"America/New_York","utc_offset_seconds":-18000,"resource":{"kind":"task","id":task.id}});
    let reminder = reminders::create(&f.db, f.actor.clone(), f.client.clone(), input(v.clone()))
        .await
        .unwrap();
    tasks::archive(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        task.id.clone(),
        input(json!({"confirm":true,"expected_revision":1})),
    )
    .await
    .unwrap();
    f.connection()
        .execute(
            "UPDATE users SET status='disabled',updated_at=?1,revision=revision+1 WHERE id=?2",
            params![validation::now(), owner],
        )
        .unwrap();
    f.connection().execute("UPDATE role_permissions SET revoked_at=?1 WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_key='tasks.view'",[validation::now()]).unwrap();
    v["expected_revision"] = json!(1);
    reminders::update(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        reminder.id.clone(),
        input(v.clone()),
    )
    .await
    .unwrap();
    let value = reminders::read(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        reminder.id.clone(),
    )
    .await
    .unwrap();
    assert_eq!(value["scheduled_at"], "2026-11-01T06:30:00.123456Z");
    assert_eq!(value["owner_id"], owner);
    assert_eq!(value["resource"]["id"], task.id);
    v["expected_revision"] = json!(2);
    v["resource"] = Value::Null;
    f.connection().execute_batch("CREATE TRIGGER reject_reminder_audit BEFORE INSERT ON audit_events WHEN NEW.resource_kind='reminder' BEGIN SELECT RAISE(ABORT,'synthetic mandatory audit failure'); END;").unwrap();
    assert!(
        reminders::update(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            reminder.id.clone(),
            input(v.clone())
        )
        .await
        .is_err()
    );
    assert_eq!(
        reminders::read(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            reminder.id.clone()
        )
        .await
        .unwrap()["revision"],
        2
    );
    f.connection()
        .execute_batch("DROP TRIGGER reject_reminder_audit")
        .unwrap();
    reminders::update(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        reminder.id.clone(),
        input(v.clone()),
    )
    .await
    .unwrap();
    v["expected_revision"] = json!(3);
    v["resource"] = json!({"kind":"task","id":task.id});
    assert_eq!(
        reminders::update(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            reminder.id.clone(),
            input(v)
        )
        .await
        .err()
        .unwrap()
        .code(),
        "invalid_resource"
    );
    let (complete, dismiss) = tokio::join!(
        reminders::complete(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            reminder.id.clone(),
            reminders::Completion {
                expected_revision: 3
            }
        ),
        reminders::dismiss(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            reminder.id.clone(),
            input(json!({"confirm":true,"expected_revision":3}))
        )
    );
    assert_ne!(complete.is_ok(), dismiss.is_ok());
    assert_eq!(f.connection().query_row("SELECT count(*) FROM audit_events WHERE resource_id=?1 AND event_name IN ('reminder.completed','reminder.dismissed')",[&reminder.id],|r|r.get::<_,i64>(0)).unwrap(),1);
    clients::archive(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(json!({"confirm":true,"expected_revision":1})),
    )
    .await
    .unwrap();
    assert!(
        reminders::read(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            reminder.id.clone()
        )
        .await
        .is_ok()
    );
    assert!(
        reminders::complete(
            &f.db,
            f.actor,
            f.client,
            reminder.id,
            reminders::Completion {
                expected_revision: 4
            }
        )
        .await
        .is_err()
    );
}
