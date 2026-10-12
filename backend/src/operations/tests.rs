use super::*;
use crate::{administration, clients, query::Query, testing::Fixture, websites};
use serde_json::{Value, json};
fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    validation::json(&serde_json::to_vec(&v).unwrap()).unwrap()
}
async fn staff_user(f: &Fixture, name: &str, brand: &str) -> Actor {
    let user=administration::create_user(&f.auth,f.actor.clone(),input(json!({"email":format!("{name}@example.com"),"display_name":name,"password":"synthetic-password"}))).await.unwrap();
    f.connection().execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES (?1,?2,'00000000-0000-4000-8000-000000000006','client',?3,?4)",params![validation::new_id(),user.id,brand,validation::now()]).unwrap();
    f.auth
        .login(
            crate::auth::Login {
                email: format!("{name}@example.com"),
                password: "synthetic-password".into(),
            },
            crate::audit::request_id(),
        )
        .await
        .unwrap()
        .session
        .actor
}
fn create_input(site: Option<String>, evidence: Vec<String>) -> requests::Create {
    input(
        json!({"command_id":validation::new_id(),"website_id":site,"brand_wide":false,"title":"Synthetic mobile purchase button","description":"The mobile purchase button is hidden.","category":"bug","priority":"normal","evidence_ids":evidence}),
    )
}
fn action(revision: &str, reason: &str) -> requests::Action {
    input(json!({"command_id":validation::new_id(),"expected_revision":revision,"reason":reason}))
}
fn png() -> Vec<u8> {
    let mut p = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    p.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1]);
    p
}
#[tokio::test]
async fn developer_defaults_are_development_scoped_and_cannot_assign_unrelated_campaign_work() {
    let f = Fixture::new().await;
    let employee = staff_user(&f, "campaign-person", &f.client).await;
    let developer = staff_user(&f, "developer-person", &f.client).await;
    let collaborator = staff_user(&f, "developer-collaborator", &f.client).await;
    for user in [&developer, &collaborator] {
        let c = f.connection();
        c.execute(
            "UPDATE user_roles SET revoked_at=?1 WHERE user_id=?2",
            params![validation::now(), user.user_id],
        )
        .unwrap();
        c.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES (?1,?2,'00000000-0000-4000-8000-000000000004','client',?3,?4)",params![validation::new_id(),user.user_id,f.client,validation::now()]).unwrap();
    }
    let campaign = crate::tasks::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(json!({"title":"Synthetic advertising campaign","assignee_id":employee.user_id})),
    )
    .await
    .unwrap();
    assert!(
        crate::tasks::read(&f.db, developer.clone(), f.client.clone(), campaign.id)
            .await
            .is_err()
    );
    assert!(
        crate::tasks::list(&f.db, developer.clone(), f.client.clone(), Query::default())
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        crate::tasks::create(
            &f.db,
            developer.clone(),
            f.client.clone(),
            input(
                json!({"title":"Synthetic unauthorized assignment","assignee_id":employee.user_id})
            )
        )
        .await
        .is_err()
    );
    assert!(
        crate::tasks::create(
            &f.db,
            developer.clone(),
            f.client.clone(),
            input(json!({"title":"Synthetic own work","assignee_id":developer.user_id}))
        )
        .await
        .is_ok()
    );
    let request=requests::create(&f.db,employee.clone(),f.client.clone(),input(json!({"command_id":validation::new_id(),"brand_wide":true,"title":"Synthetic technical request","description":"Synthetic technical work","category":"bug","priority":"normal"}))).await.unwrap();
    let rid = request["id"].as_str().unwrap().to_owned();
    let mut acceptance = action("1", "");
    acceptance.assignee_id = Some(collaborator.user_id.clone());
    requests::act(
        &f.db,
        developer.clone(),
        f.client.clone(),
        rid.clone(),
        "accept".into(),
        acceptance,
    )
    .await
    .unwrap();
    let r = requests::read(&f.db, developer.clone(), f.client.clone(), rid)
        .await
        .unwrap();
    let task = crate::tasks::read(
        &f.db,
        developer.clone(),
        f.client.clone(),
        r["task_id"].as_str().unwrap().into(),
    )
    .await
    .unwrap();
    assert_eq!(task["assignee_id"], collaborator.user_id);
    assert_eq!(task["assignee_name"], "developer-collaborator");
    assert!(
        !crate::security::allowed_user(
            &f.connection().transaction().unwrap(),
            &developer.user_id,
            "billing.view",
            Some(&f.client)
        )
        .unwrap()
    );
}
#[test]
fn state_machine_rejects_shortcuts_and_checks_all_pairs() {
    for state in requests::STATES {
        assert!(requests::transition(state, "approve").is_some() == (*state == "delivered"));
        assert!(requests::transition(state, "deliver").is_some() == (*state == "in_progress"));
        assert!(requests::transition(state, "accept").is_some() == (*state == "new"));
    }
    assert!(requests::transition("new", "done").is_none());
    assert!(requests::transition("approved", "reopen").is_none());
}
#[test]
fn evidence_rejects_executable_mismatched_and_oversized_content() {
    assert!(evidence::media(b"<svg onload='x' />", "image/png").is_err());
    assert!(evidence::media(&png(), "text/html").is_err());
    assert!(evidence::media(&[0xff, 0xd8, 0xff], "image/jpeg").is_err());
    assert_eq!(evidence::media(&png(), "image/png").unwrap(), "image/png");
    let mut oversized = png();
    oversized.resize(evidence::MAX_FILE + 1, 0);
    assert!(evidence::media(&oversized, "image/png").is_err());
}
#[tokio::test]
async fn complete_two_actor_delivery_revision_history_and_revocation() {
    let f = Fixture::new().await;
    let employee = staff_user(&f, "advertising", &f.client).await;
    let stranger = staff_user(&f, "other-employee", &f.client).await;
    let site = websites::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(json!({"name":"Synthetic shop","url":"https://shop.example.com"})),
    )
    .await
    .unwrap();
    let file = validation::new_id();
    evidence::upload(
        &f.db,
        employee.clone(),
        f.client.clone(),
        evidence::Upload {
            id: file.clone(),
            filename: "before.png".into(),
            declared: "image/png".into(),
            body: png(),
        },
        None,
    )
    .await
    .unwrap();
    let request = requests::create(
        &f.db,
        employee.clone(),
        f.client.clone(),
        create_input(Some(site.id.clone()), vec![file.clone()]),
    )
    .await
    .unwrap();
    let id = request["id"].as_str().unwrap().to_owned();
    assert!(
        requests::read(&f.db, stranger.clone(), f.client.clone(), id.clone())
            .await
            .is_err()
    );
    assert!(
        evidence::read(&f.db, stranger.clone(), f.client.clone(), file.clone())
            .await
            .is_err()
    );
    let initial = requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
        .await
        .unwrap();
    assert_eq!(initial["website_id"], site.id);
    assert!(
        requests::act(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            "reject".into(),
            action("1", "")
        )
        .await
        .is_err()
    );
    assert!(
        requests::act(
            &f.db,
            employee.clone(),
            f.client.clone(),
            id.clone(),
            "accept".into(),
            action("1", "")
        )
        .await
        .is_err()
    );
    let mut accept = action("1", "");
    accept.assignee_id = Some(f.actor.user_id.clone());
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "accept".into(),
        accept,
    )
    .await
    .unwrap();
    let accepted = requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
        .await
        .unwrap();
    let task = accepted["task_id"].as_str().unwrap().to_owned();
    assert!(
        crate::tasks::status(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            task.clone(),
            crate::tasks::Status {
                status: "in_progress".into(),
                expected_revision: 2
            }
        )
        .await
        .is_err()
    );
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "start".into(),
        action("2", ""),
    )
    .await
    .unwrap();
    let after = validation::new_id();
    evidence::upload(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        evidence::Upload {
            id: after.clone(),
            filename: "after.png".into(),
            declared: "image/png".into(),
            body: png(),
        },
        None,
    )
    .await
    .unwrap();
    let mut deliver = action("3", "Corrected the button on mobile.");
    deliver.evidence_ids = vec![after.clone()];
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "deliver".into(),
        deliver,
    )
    .await
    .unwrap();
    let first = requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
        .await
        .unwrap();
    assert_eq!(first["status"], "delivered");
    let first_id = first["deliveries"][0]["id"].as_str().unwrap().to_owned();
    let mut approve = action("4", "");
    approve.delivery_id = Some(first_id.clone());
    assert!(
        requests::act(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            "approve".into(),
            approve
        )
        .await
        .is_err()
    );
    let mut revise = action("4", "The button still overflows on a narrow phone.");
    revise.delivery_id = Some(first_id.clone());
    requests::act(
        &f.db,
        employee.clone(),
        f.client.clone(),
        id.clone(),
        "revise".into(),
        revise,
    )
    .await
    .unwrap();
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "start".into(),
        action("5", ""),
    )
    .await
    .unwrap();
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "deliver".into(),
        action("6", "Corrected the narrow screen overflow."),
    )
    .await
    .unwrap();
    let second = requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
        .await
        .unwrap();
    let mut approve = action("7", "");
    approve.delivery_id = Some(second["deliveries"][0]["id"].as_str().unwrap().into());
    requests::act(
        &f.db,
        employee.clone(),
        f.client.clone(),
        id.clone(),
        "approve".into(),
        approve,
    )
    .await
    .unwrap();
    let done = requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
        .await
        .unwrap();
    assert_eq!(done["status"], "approved");
    assert_eq!(done["deliveries"].as_array().unwrap().len(), 2);
    assert_eq!(done["reviews"].as_array().unwrap().len(), 2);
    assert_eq!(
        crate::tasks::read(&f.db, f.actor.clone(), f.client.clone(), task)
            .await
            .unwrap()["status"],
        "done"
    );
    assert_eq!(
        requests::timeline(
            &f.db,
            employee.clone(),
            f.client.clone(),
            id.clone(),
            Query::default()
        )
        .await
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    evidence::read(&f.db, employee.clone(), f.client.clone(), file.clone())
        .await
        .unwrap();
    integrity::verify(&f.connection().unchecked_transaction().unwrap()).unwrap();
    let inbox = notifications::list(&f.db, employee.clone(), Query::default())
        .await
        .unwrap();
    assert!(!inbox["data"].as_array().unwrap().is_empty());
    let nid = inbox["data"][0]["id"].as_str().unwrap().to_owned();
    assert!(
        notifications::mark(&f.db, stranger, Some(nid))
            .await
            .is_err()
    );
    f.connection()
        .execute(
            "UPDATE user_roles SET revoked_at=?1 WHERE user_id=?2",
            params![validation::now(), employee.user_id],
        )
        .unwrap();
    assert!(
        requests::read(&f.db, employee.clone(), f.client.clone(), id)
            .await
            .is_err()
    );
    assert!(
        evidence::read(&f.db, employee.clone(), f.client.clone(), file)
            .await
            .is_err()
    );
    assert!(
        notifications::list(&f.db, employee, Query::default())
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn retries_and_concurrent_acceptance_create_one_task_and_no_duplicate_events() {
    let f = Fixture::new().await;
    let mut create = create_input(None, vec![]);
    create.brand_wide = true;
    let original = serde_json::to_value(&create).unwrap();
    let a = requests::create(&f.db, f.actor.clone(), f.client.clone(), create)
        .await
        .unwrap();
    let b = requests::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(original.clone()),
    )
    .await
    .unwrap();
    assert_eq!(a["id"], b["id"]);
    assert_eq!(b["replayed"], true);
    let mut altered = original;
    altered["title"] = json!("Different title");
    assert!(
        requests::create(&f.db, f.actor.clone(), f.client.clone(), input(altered))
            .await
            .is_err()
    );
    let id = a["id"].as_str().unwrap().to_owned();
    let one = requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "accept".into(),
        action("1", ""),
    );
    let two = requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "accept".into(),
        action("1", ""),
    );
    let (one, two) = tokio::join!(one, two);
    assert_ne!(one.is_ok(), two.is_ok());
    assert_eq!(
        f.connection()
            .query_row::<i64, _, _>("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        f.connection()
            .query_row::<i64, _, _>("SELECT count(*) FROM request_events", [], |r| r.get(0))
            .unwrap(),
        2
    );
    let other = clients::create(
        &f.db,
        f.actor.clone(),
        input(json!({"name":"Other synthetic brand"})),
    )
    .await
    .unwrap()
    .id;
    let employee = staff_user(&f, "scoped", &f.client).await;
    assert!(
        requests::read(&f.db, employee.clone(), other.clone(), id)
            .await
            .is_err()
    );
    let mut create = create_input(None, vec![]);
    create.brand_wide = true;
    assert!(
        requests::create(&f.db, employee, other, create)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn employee_template_has_no_finance_and_own_task_rights_are_record_scoped() {
    let f = Fixture::new().await;
    let one = staff_user(&f, "task-one", &f.client).await;
    let two = staff_user(&f, "task-two", &f.client).await;
    let grants =
        f.db.read({
            let user = one.user_id.clone();
            move |tx| security::grants(tx, &user)
        })
        .await
        .unwrap();
    assert!(grants.iter().all(|g| !g.permission.starts_with("billing.")
        && !g.permission.starts_with("pricing.")
        && !g.permission.starts_with("finance.")));
    assert!(grants.iter().any(|g| g.permission == "tasks.read_own"));
    assert!(grants.iter().all(|g| g.permission != "tasks.view"));
    let task = crate::tasks::create(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        input(json!({"title":"Synthetic employee daily check","assignee_id":one.user_id,"due_at":"2020-01-01T00:00:00Z"})),
    )
    .await
    .unwrap();
    assert!(
        crate::tasks::read(&f.db, one.clone(), f.client.clone(), task.id.clone())
            .await
            .is_ok()
    );
    assert!(
        crate::tasks::read(&f.db, two.clone(), f.client.clone(), task.id.clone())
            .await
            .is_err()
    );
    assert_eq!(
        crate::tasks::list(&f.db, two.clone(), f.client.clone(), Query::default())
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let scope = Query::parse("limit=25&status=active", &["limit", "status"]).unwrap();
    let own = crate::tasks::queue(&f.db, one.clone(), scope.clone())
        .await
        .unwrap();
    assert_eq!(own["data"][0]["id"], task.id);
    assert!(
        crate::tasks::queue(&f.db, two.clone(), scope)
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let overview = crate::overview::read(&f.db, one.clone(), f.client.clone())
        .await
        .unwrap();
    assert_eq!(overview["tasks"]["overdue"]["items"][0]["id"], task.id);
    assert!(overview.get("finance").is_none());
    assert!(overview.get("operations").is_some());
    assert!(
        crate::overview::read(&f.db, two.clone(), f.client.clone())
            .await
            .unwrap()["tasks"]["overdue"]["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        crate::tasks::status(
            &f.db,
            two,
            f.client.clone(),
            task.id.clone(),
            crate::tasks::Status {
                status: "in_progress".into(),
                expected_revision: 1
            }
        )
        .await
        .is_err()
    );
    crate::tasks::status(
        &f.db,
        one.clone(),
        f.client.clone(),
        task.id.clone(),
        crate::tasks::Status {
            status: "in_progress".into(),
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    crate::tasks::status(
        &f.db,
        one.clone(),
        f.client.clone(),
        task.id.clone(),
        crate::tasks::Status {
            status: "done".into(),
            expected_revision: 2,
        },
    )
    .await
    .unwrap();
    let dashboard = today::read(&f.db, one, Query::default()).await.unwrap();
    assert!(dashboard.get("finance").is_none());
    assert!(dashboard.get("team_members").is_none());
}

#[tokio::test]
async fn team_assignments_grant_only_scoped_operations_and_revoke_managed_access() {
    use super::team;
    let f = Fixture::new().await;
    let leader=administration::create_user(&f.auth,f.actor.clone(),input(json!({"email":"leader@example.com","display_name":"Synthetic advertising leader","password":"synthetic-password"}))).await.unwrap();
    let employee=administration::create_user(&f.auth,f.actor.clone(),input(json!({"email":"member@example.com","display_name":"Synthetic team member","password":"synthetic-password"}))).await.unwrap();
    let team_id = validation::new_id();
    let mut team = team::create(
        &f.db,
        f.actor.clone(),
        input(json!({"id":team_id,"name":"Synthetic advertising","leader_id":leader.id})),
    )
    .await
    .unwrap();
    let leader_actor = f
        .auth
        .login(
            crate::auth::Login {
                email: "leader@example.com".into(),
                password: "synthetic-password".into(),
            },
            crate::audit::request_id(),
        )
        .await
        .unwrap()
        .session
        .actor;
    let member_actor = f
        .auth
        .login(
            crate::auth::Login {
                email: "member@example.com".into(),
                password: "synthetic-password".into(),
            },
            crate::audit::request_id(),
        )
        .await
        .unwrap()
        .session
        .actor;
    assert!(
        clients::read(&f.db, leader_actor.clone(), f.client.clone())
            .await
            .is_err()
    );
    assert!(
        crate::billing::summary(&f.db, leader_actor.clone(), f.client.clone())
            .await
            .is_err()
    );
    team = team::membership(
        &f.db,
        f.actor.clone(),
        team_id.clone(),
        input(json!({"user_id":employee.id,"active":true,"expected_revision":team["revision"]})),
    )
    .await
    .unwrap();
    team=team::assign(&f.db,f.actor.clone(),team_id.clone(),input(json!({"client_id":f.client,"user_id":leader.id,"responsibility":"Advertising lead","active":true,"expected_revision":team["revision"]}))).await.unwrap();
    team=team::assign(&f.db,leader_actor.clone(),team_id.clone(),input(json!({"client_id":f.client,"user_id":employee.id,"responsibility":"Campaign operations","active":true,"expected_revision":team["revision"]}))).await.unwrap();
    assert!(
        clients::read(&f.db, member_actor.clone(), f.client.clone())
            .await
            .is_ok()
    );
    assert!(
        crate::billing::summary(&f.db, member_actor.clone(), f.client.clone())
            .await
            .is_err()
    );
    assert!(
        team::membership(
            &f.db,
            leader_actor.clone(),
            team_id.clone(),
            input(
                json!({"user_id":employee.id,"active":false,"expected_revision":team["revision"]})
            )
        )
        .await
        .is_err()
    );
    let other=clients::create(&f.db,f.actor.clone(),input(json!({"name":"Synthetic unrelated brand","legal_name":"","website":"","notes":"","contacts":[],"tags":[]}))).await.unwrap();
    assert!(
        clients::read(&f.db, member_actor.clone(), other.id.clone())
            .await
            .is_err()
    );
    assert!(team::assign(&f.db,leader_actor.clone(),team_id.clone(),input(json!({"client_id":other.id,"user_id":employee.id,"responsibility":"","active":true,"expected_revision":team["revision"]}))).await.is_err());
    let task=crate::tasks::create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"title":"Synthetic assigned daily work","description":"","status":"todo","priority":"medium","assignee_id":employee.id,"tags":[]}))).await.unwrap();
    let mut request = create_input(None, vec![]);
    request.brand_wide = true;
    let request = requests::create(&f.db, member_actor.clone(), f.client.clone(), request)
        .await
        .unwrap();
    assert!(
        requests::read(
            &f.db,
            leader_actor.clone(),
            f.client.clone(),
            request["id"].as_str().unwrap().into()
        )
        .await
        .is_ok()
    );
    team::assign(&f.db,leader_actor.clone(),team_id.clone(),input(json!({"client_id":f.client,"user_id":employee.id,"responsibility":"","active":false,"expected_revision":team["revision"]}))).await.unwrap();
    assert!(
        clients::read(&f.db, member_actor.clone(), f.client.clone())
            .await
            .is_err()
    );
    assert!(
        requests::read(
            &f.db,
            member_actor.clone(),
            f.client.clone(),
            request["id"].as_str().unwrap().into()
        )
        .await
        .is_err()
    );
    assert!(
        requests::read(
            &f.db,
            leader_actor.clone(),
            f.client.clone(),
            request["id"].as_str().unwrap().into()
        )
        .await
        .is_ok()
    );
    assert!(
        f.connection()
            .query_row(
                "SELECT assignee_id IS NULL FROM tasks WHERE id=?1",
                [task.id],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
    );
    assert_eq!(f.connection().query_row("SELECT count(*) FROM brand_staff_assignments WHERE user_id=?1 AND revoked_at IS NOT NULL",[employee.id],|r|r.get::<_,i64>(0)).unwrap(),1);
    let next=administration::create_user(&f.auth,f.actor.clone(),input(json!({"email":"synthetic-next-leader@example.com","display_name":"Synthetic next leader","password":"synthetic-password"}))).await.unwrap();
    let current = team::read(&f.db, f.actor.clone(), team_id.clone())
        .await
        .unwrap();
    let changed=team::update(&f.db,f.actor.clone(),team_id.clone(),input(json!({"name":current["name"],"leader_id":next.id,"archived":false,"expected_revision":current["revision"]}))).await.unwrap();
    assert!(
        team::read(&f.db, leader_actor.clone(), team_id.clone())
            .await
            .is_err()
    );
    assert!(
        clients::read(&f.db, leader_actor.clone(), f.client.clone())
            .await
            .is_err()
    );
    let historical =
        team::leadership_history(&f.db, f.actor.clone(), team_id.clone(), Query::default())
            .await
            .unwrap();
    assert_eq!(historical["data"].as_array().unwrap().len(), 2);
    let assigned=team::assign(&f.db,f.actor.clone(),team_id.clone(),input(json!({"client_id":f.client,"user_id":next.id,"responsibility":"Synthetic new leadership","active":true,"expected_revision":changed["revision"]}))).await.unwrap();
    assert!(
        assigned["revision"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap()
            > changed["revision"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .unwrap()
    );
}

#[tokio::test]
async fn retained_delivery_pages_and_timeline_cross_multiple_boundaries() {
    let f = Fixture::new().await;
    let employee = staff_user(&f, "history-reviewer", &f.client).await;
    let mut creation = create_input(None, vec![]);
    creation.brand_wide = true;
    let r = requests::create(&f.db, employee.clone(), f.client.clone(), creation)
        .await
        .unwrap();
    let id = r["id"].as_str().unwrap().to_owned();
    let mut accept = action("1", "");
    accept.assignee_id = Some(f.actor.user_id.clone());
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "accept".into(),
        accept,
    )
    .await
    .unwrap();
    let mut revision = 2;
    for number in 1..=30 {
        requests::act(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            "start".into(),
            action(&revision.to_string(), ""),
        )
        .await
        .unwrap();
        revision += 1;
        requests::act(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            "deliver".into(),
            action(
                &revision.to_string(),
                &format!("Synthetic delivery version {number}"),
            ),
        )
        .await
        .unwrap();
        revision += 1;
        let doc = requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
            .await
            .unwrap();
        let mut review = action(&revision.to_string(), "Synthetic scoped review reason");
        review.delivery_id = Some(doc["deliveries"][0]["id"].as_str().unwrap().into());
        requests::act(
            &f.db,
            employee.clone(),
            f.client.clone(),
            id.clone(),
            if number == 30 { "approve" } else { "revise" }.into(),
            review,
        )
        .await
        .unwrap();
        revision += 1;
    }
    let recent = requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
        .await
        .unwrap();
    assert_eq!(recent["deliveries"].as_array().unwrap().len(), 25);
    assert_eq!(recent["deliveries"][0]["number"], 30);
    let old = requests::deliveries(
        &f.db,
        employee.clone(),
        f.client.clone(),
        id.clone(),
        Query::parse("limit=25&before=6", &["limit", "before"]).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(old["data"].as_array().unwrap().len(), 5);
    assert_eq!(old["reviews"].as_array().unwrap().len(), 5);
    assert_eq!(old["data"][0]["number"], 5);
    assert!(old["page"]["next_before"].is_null());
    let events = requests::timeline(
        &f.db,
        employee,
        f.client.clone(),
        id,
        Query::parse("limit=25&after=25", &["limit", "after"]).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(events["data"][0]["sequence"], "26");
    assert_eq!(events["data"].as_array().unwrap().len(), 25);
    integrity::verify(&f.connection().unchecked_transaction().unwrap()).unwrap();
}

#[tokio::test]
async fn rejection_requires_a_reason_and_reopening_retains_the_original_decision() {
    let f = Fixture::new().await;
    let employee = staff_user(&f, "decision-requester", &f.client).await;
    let mut creation = create_input(None, vec![]);
    creation.brand_wide = true;
    let request = requests::create(&f.db, employee.clone(), f.client.clone(), creation)
        .await
        .unwrap();
    let id = request["id"].as_str().unwrap().to_owned();
    assert!(matches!(
        requests::act(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            "reject".into(),
            action("1", "")
        )
        .await,
        Err(Error::Invalid(_))
    ));
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "reject".into(),
        action(
            "1",
            "Synthetic integration requires technical confirmation.",
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        requests::read(&f.db, employee.clone(), f.client.clone(), id.clone())
            .await
            .unwrap()["status"],
        "rejected"
    );
    requests::act(
        &f.db,
        f.actor.clone(),
        f.client.clone(),
        id.clone(),
        "reopen".into(),
        action("2", "Synthetic required confirmation received."),
    )
    .await
    .unwrap();
    let events = requests::timeline(&f.db, employee, f.client.clone(), id, Query::default())
        .await
        .unwrap();
    assert_eq!(events["data"][1]["action"], "rejected");
    assert_eq!(
        events["data"][1]["text"],
        "Synthetic integration requires technical confirmation."
    );
    assert_eq!(events["data"][2]["action"], "reopened");
    assert_eq!(
        f.connection()
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn today_finance_preserves_wide_exact_totals_currency_scope_and_revoked_access() {
    use crate::billing;
    let f = Fixture::new().await;
    let other = clients::create(
        &f.db,
        f.actor.clone(),
        input(json!({"name":"Synthetic second financial brand"})),
    )
    .await
    .unwrap();
    let yesterday = chrono::Utc::now()
        .date_naive()
        .pred_opt()
        .unwrap()
        .to_string();
    for brand in [&f.client, &other.id] {
        billing::create(
            &f.db,
            f.actor.clone(),
            brand.clone(),
            input(json!({"description":"Synthetic exact EUR obligation","currency":"EUR","amount_minor":i64::MAX.to_string(),"due_date":yesterday})),
        ).await.unwrap();
    }
    let software=billing::create(
        &f.db,f.actor.clone(),f.client.clone(),
        input(json!({"description":"Synthetic monthly software","currency":"USD","amount_minor":"100000","due_date":yesterday})),
    ).await.unwrap();
    billing::record_payment(
        &f.db,f.actor.clone(),f.client.clone(),software.id,
        input(json!({"expected_revision":"1","command_id":validation::new_id(),"currency":"USD","amount_minor":"60000","paid_on":yesterday,"method":"bank_transfer"})),
    ).await.unwrap();
    let dashboard = today::read(&f.db, f.actor.clone(), Query::default())
        .await
        .unwrap();
    assert_eq!(
        dashboard["finance"],
        json!([
            {"currency":"EUR","outstanding_minor":"18446744073709551614","overdue_minor":"18446744073709551614"},
            {"currency":"USD","outstanding_minor":"40000","overdue_minor":"40000"}
        ])
    );
    let scoped = today::read(
        &f.db,
        f.actor.clone(),
        Query::parse(&format!("client_id={}", f.client), &["client_id"]).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        scoped["finance"][0]["outstanding_minor"],
        i64::MAX.to_string()
    );
    assert_eq!(scoped["finance"][1]["outstanding_minor"], "40000");
    f.connection().execute("UPDATE role_permissions SET revoked_at=?2 WHERE role_id=?1 AND permission_key='billing.view'",params![crate::db::ADMIN_ROLE,validation::now()]).unwrap();
    let withdrawn = today::read(&f.db, f.actor, Query::default()).await.unwrap();
    assert_eq!(withdrawn["finance"], json!([]));
}
